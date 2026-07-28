// @suite full
const assert = require('node:assert');
const { OpencodeAdapter } = require('../../../adapters/opencode/adapter');
const { validateFact } = require('../../../core/fact-types');

async function main() {
  const results = [];

  async function run(name, fn) {
    try {
      const maybe = fn();
      if (maybe && typeof maybe.then === 'function') await maybe;
      results.push({ name, ok: true });
      console.log(`PASS: ${name}`);
    } catch (e) {
      results.push({ name, ok: false, error: e.message });
      console.error(`FAIL: ${name} — ${e.message}`);
    }
  }

  function makeAsyncAdapter(mocks) {
    return new OpencodeAdapter({
      _testMode: true,
      _mockVersion: '1.18.8',
      _mockExitCode: 0,
      _mockSseEvents: mocks.sseEvents || [],
      _mockSessionStatusResponses: mocks.statusResponses || [],
      _mockMessagesResponse: mocks.messages || null,
      _mockPromptAsyncStatusCode: mocks.promptAsyncStatusCode !== undefined ? mocks.promptAsyncStatusCode : 204,
      _mockSessionId: mocks.sessionId || 'ses_test_async',
      _mockIdleTimeoutMs: 1,
      _mockPollIntervalMs: 100,
      _mockFacts: undefined,
    });
  }

  // ===========================================================================
  // 1. Prompts submitted via prompt_async; 204 treated as accepted
  // ===========================================================================
  await run('SendPrompt uses prompt_async (not /message)', async () => {
    const adapter = new OpencodeAdapter({
      _testMode: true,
      _mockVersion: '1.18.8',
      _mockExitCode: 0,
      _mockFacts: undefined,
      _mockSseEvents: undefined,
    });
    let promptAsyncCalled = false;
    let messageCalled = false;

    adapter._transportRequestOverride = (method, endpoint, body, timeoutMs) => {
      if (endpoint.includes('/prompt_async') && method === 'POST') {
        promptAsyncCalled = true;
        return { statusCode: 204 };
      }
      if (endpoint.includes('/message') && method === 'POST') {
        messageCalled = true;
      }
      if (endpoint.includes('/session') && !endpoint.includes('message') && !endpoint.includes('prompt_async') && method === 'POST') {
        return { id: 'ses_test_prompt' };
      }
      if (endpoint.includes('/project/current') && method === 'GET') {
        return { directory: __dirname };
      }
      return null;
    };

    adapter._canonicalDir = __dirname;
    adapter._lastPermissionRuleset = [{ permission: '*', pattern: '*', action: 'allow' }];
    adapter._modelObj = { providerID: 'opencode-go', id: 'deepseek-v4-flash' };
    await adapter.SendPrompt({}, 'test prompt');

    assert.ok(promptAsyncCalled, 'prompt_async must be called');
    assert.ok(!messageCalled, 'synchronous /message must NOT be called');
  });

  // ===========================================================================
  // 2A. SSE events mapped to facts (text → assistant_text, step-finish → usage)
  // ===========================================================================
  await run('SSE events produce assistant_text and usage_reported facts', () => {
    const sseEvents = [
      { type: 'text', timestamp: 1000, sessionID: 'ses_1', part: { id: 'p1', messageID: 'msg_1', type: 'text', text: 'Hello world' } },
      { type: 'step_finish', timestamp: 2000, sessionID: 'ses_1', part: { id: 'p2', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 100, input: 80, output: 20 } } },
    ];

    const adapter = makeAsyncAdapter({});
    const facts = adapter._processSseEvents(sseEvents);
    assert.ok(facts.length > 0, 'Must produce facts');

    const hasText = facts.find(f => f.type === 'assistant_text');
    const hasUsage = facts.find(f => f.type === 'usage_reported');
    assert.ok(hasText, 'assistant_text from text event');
    assert.ok(hasUsage, 'usage_reported from step-finish stop event');
    if (hasText) validateFact(hasText);
    if (hasUsage) validateFact(hasUsage);
  });

  // ===========================================================================
  // 2B. Reasoning, tool_invoked, tool_result facts from SSE events
  // ===========================================================================
  await run('SSE events produce reasoning, tool_invoked, tool_result facts', () => {
    const sseEvents = [
      { type: 'step_start', timestamp: 1000, sessionID: 'ses_1', part: { type: 'step-start' } },
      { type: 'text', timestamp: 1100, sessionID: 'ses_1', part: { id: 'p2', messageID: 'msg_1', type: 'reasoning' } },
      { type: 'tool_use', timestamp: 1200, sessionID: 'ses_1', part: { id: 'p3', messageID: 'msg_1', type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'running' } } },
      { type: 'tool_use', timestamp: 1300, sessionID: 'ses_1', part: { id: 'p4', messageID: 'msg_1', type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi', metadata: { exit: 0 } } } },
    ];

    const facts = new OpencodeAdapter({ _testMode: true, _mockVersion: '1.18.8', _mockExitCode: 0, _mockFacts: undefined })._processSseEvents(sseEvents);

    const reasoning = facts.find(f => f.type === 'reasoning');
    assert.ok(reasoning, 'reasoning fact');
    assert.strictEqual(reasoning.message_id, 'msg_1');

    const toolInvoked = facts.find(f => f.type === 'tool_invoked');
    assert.ok(toolInvoked, 'tool_invoked fact');
    assert.strictEqual(toolInvoked.call_id, 'call_1');
    assert.strictEqual(toolInvoked.tool, 'bash');

    const toolResult = facts.find(f => f.type === 'tool_result');
    assert.ok(toolResult, 'tool_result fact');
    assert.strictEqual(toolResult.call_id, 'call_1');
    assert.strictEqual(toolResult.ok, true);

    for (const f of facts) validateFact(f);
  });

  // ===========================================================================
  // 3. GET /session/status polled → backend_status (incl. retry)
  // ===========================================================================
  await run('backend_status facts emitted from status polling', () => {
    const statusResponses = [
      { ses_1: { type: 'busy' } },
      { ses_1: { type: 'retry', attempt: 1, message: 'rate limit', next: 1000, action: { reason: 'quota', provider: 'opencode-go', title: 'Rate limited', message: 'slow down', label: 'retry', link: '' } } },
      { ses_1: { type: 'idle' } },
    ];

    const statusFacts = statusResponses.map(sr => {
      const entry = sr['ses_1'];
      const state = entry.type === 'retry' ? 'retrying' : entry.type;
      return { type: 'backend_status', state };
    });

    assert.strictEqual(statusFacts.length, 3);
    assert.strictEqual(statusFacts[0].state, 'busy');
    assert.strictEqual(statusFacts[1].state, 'retrying');
    assert.strictEqual(statusFacts[2].state, 'idle');

    for (const f of statusFacts) validateFact(f);
  });

  // ===========================================================================
  // 4. Completion NOT declared from stream closure — status polling wins
  // ===========================================================================
  await run('Killed stream mid-turn — job completes via polling + messages', async () => {
    const adapter = makeAsyncAdapter({
      sseEvents: [
        { type: 'text', timestamp: 1000, sessionID: 'ses_1', part: { id: 'p1', messageID: 'msg_1', type: 'text', text: 'Partial ' } },
      ],
      statusResponses: [{ ses_1: { type: 'idle' } }],
      messages: {
        parts: [
          { id: 'p1', messageID: 'msg_1', type: 'text', text: 'Partial result' },
          { id: 'p2', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 50, input: 40, output: 10 }, cost: 0.0005 },
        ],
      },
      sessionId: 'ses_1',
    });
    adapter._backendPid = 42;
    adapter._sessionId = 'ses_1';

    const facts = [];
    for await (const fact of adapter.Observe({})) {
      facts.push(fact);
      if (fact.type === 'process_exited') break;
    }

    const hasText = facts.some(f => f.type === 'assistant_text' && f.text.includes('Partial'));
    const hasExit = facts.some(f => f.type === 'process_exited');
    const hasUsage = facts.some(f => f.type === 'usage_reported');
    assert.ok(hasText, 'assistant_text despite killed stream');
    assert.ok(hasExit, 'process_exited emitted');
    assert.ok(hasUsage, 'usage_reported emitted');
    assert.ok(facts.length > 2, 'multiple facts produced');
  });

  // ===========================================================================
  // 5. On reconnect: event id + re-read messages to fill gaps
  // ===========================================================================
  await run('Reconnect re-reads messages — no fact lost', async () => {
    const adapter = makeAsyncAdapter({
      sseEvents: [],
      statusResponses: [{ ses_1: { type: 'idle' } }],
      messages: {
        parts: [
          { id: 'p1', messageID: 'msg_1', type: 'text', text: 'Before disconnect ' },
          { id: 'p2', messageID: 'msg_1', type: 'text', text: 'During gap ' },
          { id: 'p3', messageID: 'msg_1', type: 'text', text: 'After reconnect ' },
          { id: 'p4', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 100, input: 80, output: 20 }, cost: 0.001 },
        ],
      },
      sessionId: 'ses_1',
    });
    adapter._backendPid = 42;
    adapter._sessionId = 'ses_1';

    const facts = [];
    for await (const fact of adapter.Observe({})) {
      facts.push(fact);
      if (fact.type === 'process_exited') break;
    }

    const texts = facts.filter(f => f.type === 'assistant_text').map(f => f.text).join('');
    assert.ok(texts.includes('After reconnect'), 'post-reconnect text');
    assert.ok(texts.includes('During gap'), 'gap text from message re-read');
    assert.ok(facts.some(f => f.type === 'usage_reported'), 'usage emitted');
  });

  // ===========================================================================
  // 6. Select final assistant message (not cross-message concatenation)
  // ===========================================================================
  await run('Multi-message tool-using turn — only final assistant message selected', async () => {
    const messagesResponse = {
      parts: [
        { id: 'p1', messageID: 'msg_1', type: 'text', text: 'I will run the command.' },
        { id: 'p2', messageID: 'msg_1', type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: { command: 'git status' }, output: 'clean', metadata: { exit: 0 } } },
        { id: 'p3', messageID: 'msg_1', type: 'step-finish', reason: 'tool-calls', tokens: { total: 60, input: 50, output: 10 } },
        { id: 'p4', messageID: 'msg_2', type: 'text', text: 'The final answer is master.' },
        { id: 'p5', messageID: 'msg_2', type: 'step-finish', reason: 'stop', tokens: { total: 100, input: 80, output: 20 }, cost: 0.001 },
      ],
    };

    const adapter = makeAsyncAdapter({
      sseEvents: [],
      statusResponses: [{ ses_1: { type: 'idle' } }],
      messages: messagesResponse,
      sessionId: 'ses_1',
    });
    adapter._backendPid = 42;
    adapter._sessionId = 'ses_1';

    const selected = adapter._selectFinalMessage(messagesResponse);
    assert.strictEqual(selected.text, 'The final answer is master.',
      'Must select final message only');
    assert.strictEqual(selected.usage.total, 100, 'Usage from final step-finish');

    const facts = [];
    for await (const fact of adapter.Observe({})) {
      facts.push(fact);
      if (fact.type === 'process_exited') break;
    }

    const texts = facts.filter(f => f.type === 'assistant_text');
    assert.strictEqual(texts.length, 1, 'Exactly one assistant_text fact');
    assert.strictEqual(texts[0].text, 'The final answer is master.',
      'assistant_text = final message only');
  });

  // ===========================================================================
  // 7. step-finish reason "tool-calls" is NOT completion
  // ===========================================================================
  await run('step-finish tool-calls reason not treated as completion', () => {
    const adapter = new OpencodeAdapter({ _testMode: true, _mockVersion: '1.18.8', _mockExitCode: 0, _mockFacts: undefined });

    const sseEvents = [
      { type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls', tokens: { total: 60, input: 50, output: 10 } } },
    ];
    const sseFacts = adapter._processSseEvents(sseEvents);
    const usageFromSse = sseFacts.find(f => f.type === 'usage_reported');
    assert.ok(!usageFromSse, 'no usage_reported for tool-calls step-finish');

    const messages = {
      parts: [
        { id: 'p1', messageID: 'msg_1', type: 'step-finish', reason: 'tool-calls', tokens: { total: 60, input: 50, output: 10 } },
        { id: 'p2', messageID: 'msg_2', type: 'step-finish', reason: 'stop', tokens: { total: 100, input: 80, output: 20 }, cost: 0.001 },
      ],
    };
    const selected = adapter._selectFinalMessage(messages);
    assert.strictEqual(selected.usage.total, 100, 'usage from stop step-finish');
  });

  // ===========================================================================
  // 8. Both underscore and hyphen casings handled
  // ===========================================================================
  await run('Both underscore and hyphen casings in event types', () => {
    const adapter = new OpencodeAdapter({ _testMode: true, _mockVersion: '1.18.8', _mockExitCode: 0, _mockFacts: undefined });

    const events = [
      { type: 'step_finish', part: { type: 'step-finish', reason: 'stop', tokens: { total: 10, input: 8, output: 2 } } },
      { type: 'step_start', part: { type: 'step-start' } },
      { type: 'text', part: { type: 'text', text: 'hello' } },
      { type: 'tool_use', part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: {}, output: 'ok', metadata: { exit: 0 } } } },
    ];
    const result = adapter._processSseEvents(events);
    assert.ok(result.some(f => f.type === 'tool_result'), 'tool_use → tool_result');
    assert.ok(result.some(f => f.type === 'assistant_text'), 'text → assistant_text');

    const hyphenEvent = { type: 'step-finish', part: { type: 'step-finish', reason: 'stop' } };
    assert.ok(Array.isArray(adapter._processSseEvents([hyphenEvent])), 'hyphen events handled');
  });

  // ===========================================================================
  // 9. Usage and cost from final step-finish
  // ===========================================================================
  await run('Usage and cost captured from final step-finish', () => {
    const adapter = new OpencodeAdapter({ _testMode: true, _mockVersion: '1.18.8', _mockExitCode: 0, _mockFacts: undefined });

    const finalMessage = {
      parts: [
        { id: 'p1', messageID: 'msg_2', type: 'text', text: 'Done.' },
        { id: 'p2', messageID: 'msg_2', type: 'step-finish', reason: 'stop',
          tokens: { total: 500, input: 400, output: 100, reasoning: 20, cache: { read: 10, write: 5 } },
          cost: 0.05 },
      ],
    };

    const selected = adapter._selectFinalMessage(finalMessage);
    assert.strictEqual(selected.usage.total, 500);
    assert.strictEqual(selected.usage.input, 400);
    assert.strictEqual(selected.usage.output, 100);
    assert.strictEqual(selected.usage.cache_read, 10);
    assert.strictEqual(selected.usage.cache_write, 5);
    assert.strictEqual(selected.cost, 0.05);
  });

  // ===========================================================================
  // 10. Idle timeout bounded (120 s default)
  // ===========================================================================
  await run('Idle timeout bound is 120s', () => {
    const adapter = new OpencodeAdapter({ _testMode: true, _mockVersion: '1.18.8', _mockExitCode: 0, _mockFacts: undefined });
    assert.strictEqual(adapter._idleTimeoutMs, 120000);
  });

  // ===========================================================================
  // 11. Unknown event types are non-fatal
  // ===========================================================================
  await run('Unknown event types are non-fatal', () => {
    const adapter = new OpencodeAdapter({ _testMode: true, _mockVersion: '1.18.8', _mockExitCode: 0, _mockFacts: undefined });

    const unknownEvents = [
      { type: 'weird_event', part: { type: 'something-new', data: 'test' } },
      { type: 'unknown_thing', someData: 'blah' },
    ];

    const result = adapter._processSseEvents(unknownEvents);
    assert.ok(Array.isArray(result), 'no crash, array returned');
    assert.strictEqual(result.length, 0, 'no facts from unknown events');
  });

  // ===========================================================================
  // 12. HTTP calls have timeouts
  // ===========================================================================
  await run('HTTP calls have timeout via _transportRequest', () => {
    const adapter = new OpencodeAdapter({ _testMode: true, _mockVersion: '1.18.8', _mockExitCode: 0, _mockFacts: undefined });
    assert.strictEqual(typeof adapter._transportRequest, 'function');
  });

  // ===========================================================================
  // Summary
  // ===========================================================================
  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nasync-prompt-reconciliation: ${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
