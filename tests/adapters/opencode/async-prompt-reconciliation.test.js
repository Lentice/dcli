// @suite full
// Async-prompt reconciliation, driven through the ticket-100 seams: the turn
// module (SSE reconnect, status polling, idle confirmation, message selection)
// runs against a scripted transport; SendPrompt runs against a scripted
// adapter transport. No _testMode, no private methods.
const assert = require('node:assert');
const { OpencodeAdapter } = require('../../../adapters/opencode/adapter');
const { OpencodeTurn } = require('../../../adapters/opencode/turn');
const { FakeTransport } = require('../../fixtures/fake-transport');
const { validateFact } = require('../../../core/fact-types');

const TURN_TIMINGS = {
  pollIntervalMs: 0,
  interactionPollMs: 1000000,
  idleConfirmMs: 1,
};

function makeTurn(script) {
  const transport = new FakeTransport({ script });
  const turn = new OpencodeTurn({
    transport,
    buildPath: (ep) => ep,
    timings: TURN_TIMINGS,
  });
  return { transport, turn };
}

const DEFAULT_SCRIPT = {
  '/session/status': { ses_1: { type: 'idle' } },
  '/session/ses_1/message': {
    parts: [
      { id: 'p1', messageID: 'msg_1', type: 'text', text: 'result' },
      { id: 'p2', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 10, input: 5, output: 5 } },
    ],
  },
  '/permission': [],
  '/question': [],
};

async function collectTurn(script, session = { id: 'ses_1', promptSentAt: Date.now(), backendPid: 42 }) {
  const { turn } = makeTurn(script);
  const facts = [];
  for await (const fact of turn.run({ session, deadline: null })) {
    facts.push(fact);
    if (fact.type === 'process_exited') break;
  }
  return { turn, facts };
}

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

  // ===========================================================================
  // 1. Prompts submitted via prompt_async; 204 treated as accepted
  // ===========================================================================
  await run('SendPrompt uses prompt_async (not /message)', async () => {
    const transport = new FakeTransport({
      script: {
        '/project/current': { directory: __dirname },
        '/session': { id: 'ses_test_prompt' },
        '/session/ses_test_prompt/prompt_async': { status: 204 },
      },
    });
    const adapter = new OpencodeAdapter({ transport });
    adapter.PrepareInvocation({}, { canonicalDir: __dirname, access: 'read-only' });
    await adapter.SendPrompt({}, 'test prompt');

    const calls = transport.calls.map(c => `${c.method} ${c.path.split('?')[0]}`);
    assert.ok(calls.some(c => c === 'POST /session/ses_test_prompt/prompt_async'), 'prompt_async must be called');
    assert.ok(!calls.some(c => c.includes('/message') && c.startsWith('POST')), 'synchronous /message must NOT be called');
  });

  // ===========================================================================
  // 2A. SSE events mapped to facts (text → assistant_text, step-finish → usage)
  // ===========================================================================
  await run('SSE events produce assistant_text and usage_reported facts', async () => {
    const { facts } = await collectTurn({
      ...DEFAULT_SCRIPT,
      '/event': [
        { type: 'text', timestamp: 1000, sessionID: 'ses_1', part: { id: 'p1', messageID: 'msg_1', type: 'text', text: 'Hello world' } },
        { type: 'step_finish', timestamp: 2000, sessionID: 'ses_1', part: { id: 'p2', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 100, input: 80, output: 20 } } },
      ],
    });

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
  await run('SSE events produce reasoning, tool_invoked, tool_result facts', async () => {
    const { facts } = await collectTurn({
      ...DEFAULT_SCRIPT,
      '/event': [
        { type: 'step_start', timestamp: 1000, sessionID: 'ses_1', part: { type: 'step-start' } },
        { type: 'text', timestamp: 1100, sessionID: 'ses_1', part: { id: 'p2', messageID: 'msg_1', type: 'reasoning' } },
        { type: 'tool_use', timestamp: 1200, sessionID: 'ses_1', part: { id: 'p3', messageID: 'msg_1', type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'running' } } },
        { type: 'tool_use', timestamp: 1300, sessionID: 'ses_1', part: { id: 'p4', messageID: 'msg_1', type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi', metadata: { exit: 0 } } } },
      ],
    });

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
  await run('backend_status facts emitted from status polling', async () => {
    const statuses = [
      { ses_1: { type: 'busy' } },
      { ses_1: { type: 'retry', attempt: 1, message: 'rate limit', next: 1000, action: { reason: 'quota', provider: 'opencode-go', title: 'Rate limited', message: 'slow down', label: 'retry', link: '' } } },
      { ses_1: { type: 'idle' } },
    ];
    let i = 0;
    const { facts } = await collectTurn({
      ...DEFAULT_SCRIPT,
      '/session/status': () => statuses[Math.min(i++, statuses.length - 1)],
    });

    const statusFacts = facts.filter(f => f.type === 'backend_status');
    assert.ok(statusFacts.length >= 3, `expected at least 3 status facts, got ${statusFacts.length}`);
    assert.strictEqual(statusFacts[0].state, 'busy');
    assert.ok(statusFacts.some(f => f.state === 'retrying'), 'retry maps to retrying');
    assert.ok(statusFacts.some(f => f.state === 'idle'), 'idle status emitted');

    for (const f of statusFacts) validateFact(f);
  });

  // ===========================================================================
  // 4. Completion NOT declared from stream closure — status polling wins
  // ===========================================================================
  await run('Killed stream mid-turn — job completes via polling + messages', async () => {
    const { facts } = await collectTurn({
      ...DEFAULT_SCRIPT,
      '/event': [
        { type: 'text', timestamp: 1000, sessionID: 'ses_1', part: { id: 'p1', messageID: 'msg_1', type: 'text', text: 'Partial ' } },
      ],
      '/session/ses_1/message': {
        parts: [
          { id: 'p1', messageID: 'msg_1', type: 'text', text: 'Partial result' },
          { id: 'p2', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 50, input: 40, output: 10 }, cost: 0.0005 },
        ],
      },
    });

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
    const { facts } = await collectTurn({
      ...DEFAULT_SCRIPT,
      '/event': [],
      '/session/ses_1/message': {
        parts: [
          { id: 'p1', messageID: 'msg_1', type: 'text', text: 'Before disconnect ' },
          { id: 'p2', messageID: 'msg_1', type: 'text', text: 'During gap ' },
          { id: 'p3', messageID: 'msg_1', type: 'text', text: 'After reconnect ' },
          { id: 'p4', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 100, input: 80, output: 20 }, cost: 0.001 },
        ],
      },
    });

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

    const { turn, facts } = await collectTurn({
      ...DEFAULT_SCRIPT,
      '/event': [],
      '/session/ses_1/message': messagesResponse,
    });

    const texts = facts.filter(f => f.type === 'assistant_text');
    assert.strictEqual(texts.length, 1, 'Exactly one assistant_text fact');
    assert.strictEqual(texts[0].text, 'The final answer is master.',
      'assistant_text = final message only');
    assert.strictEqual(turn.result.usage.total, 100, 'Usage from final step-finish');
  });

  // ===========================================================================
  // 7. step-finish reason "tool-calls" is NOT completion
  // ===========================================================================
  await run('step-finish tool-calls reason not treated as completion', async () => {
    // A stream carrying only a tool-calls step-finish emits no usage_reported
    // during the stream; the only usage_reported is the finalization's. A stop
    // step-finish emits one mid-stream — so the count differs by one.
    const toolCallsOnly = await collectTurn({
      ...DEFAULT_SCRIPT,
      '/event': [
        { type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls', tokens: { total: 60, input: 50, output: 10 } } },
      ],
      '/session/ses_1/message': {
        parts: [
          { id: 'p1', messageID: 'msg_1', type: 'step-finish', reason: 'tool-calls', tokens: { total: 60, input: 50, output: 10 } },
          { id: 'p2', messageID: 'msg_2', type: 'step-finish', reason: 'stop', tokens: { total: 100, input: 80, output: 20 }, cost: 0.001 },
        ],
      },
    });
    const toolCallsUsage = toolCallsOnly.facts.filter(f => f.type === 'usage_reported');
    assert.strictEqual(toolCallsUsage.length, 1, 'no usage_reported for tool-calls step-finish mid-stream');

    const withStop = await collectTurn({
      ...DEFAULT_SCRIPT,
      '/event': [
        { type: 'step_finish', part: { type: 'step-finish', reason: 'stop', tokens: { total: 10, input: 8, output: 2 } } },
      ],
    });
    const stopUsage = withStop.facts.filter(f => f.type === 'usage_reported');
    assert.ok(stopUsage.length >= 2, 'stop step-finish emits usage mid-stream plus finalization');
    assert.strictEqual(toolCallsOnly.turn.result.usage.total, 100, 'usage from stop step-finish');
  });

  // ===========================================================================
  // 8. Both underscore and hyphen casings handled
  // ===========================================================================
  await run('Both underscore and hyphen casings in event types', async () => {
    const { facts } = await collectTurn({
      ...DEFAULT_SCRIPT,
      '/event': [
        { type: 'step_finish', part: { type: 'step-finish', reason: 'stop', tokens: { total: 10, input: 8, output: 2 } } },
        { type: 'step-finish', part: { type: 'step-finish', reason: 'stop', tokens: { total: 20, input: 16, output: 4 } } },
        { type: 'step_start', part: { type: 'step-start' } },
        { type: 'text', part: { type: 'text', text: 'hello' } },
        { type: 'tool_use', part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: {}, output: 'ok', metadata: { exit: 0 } } } },
      ],
    });
    assert.ok(facts.some(f => f.type === 'tool_result'), 'tool_use → tool_result');
    assert.ok(facts.some(f => f.type === 'assistant_text'), 'text → assistant_text');
    const usage = facts.filter(f => f.type === 'usage_reported');
    assert.ok(usage.length >= 2, 'hyphen and underscore step-finish both parsed');
  });

  // ===========================================================================
  // 9. Usage and cost from final step-finish
  // ===========================================================================
  await run('Usage and cost captured from final step-finish', async () => {
    const { turn } = await collectTurn({
      ...DEFAULT_SCRIPT,
      '/session/ses_1/message': {
        parts: [
          { id: 'p1', messageID: 'msg_2', type: 'text', text: 'Done.' },
          { id: 'p2', messageID: 'msg_2', type: 'step-finish', reason: 'stop',
            tokens: { total: 500, input: 400, output: 100, reasoning: 20, cache: { read: 10, write: 5 } },
            cost: 0.05 },
        ],
      },
    });
    assert.strictEqual(turn.result.usage.total, 500);
    assert.strictEqual(turn.result.usage.input, 400);
    assert.strictEqual(turn.result.usage.output, 100);
    assert.strictEqual(turn.result.usage.cache_read, 10);
    assert.strictEqual(turn.result.usage.cache_write, 5);
    assert.strictEqual(turn.result.cost, 0.05);
  });

  // ===========================================================================
  // 10. Unknown event types are non-fatal
  // ===========================================================================
  await run('Unknown event types are non-fatal', async () => {
    const { facts } = await collectTurn({
      ...DEFAULT_SCRIPT,
      '/event': [
        { type: 'weird_event', part: { type: 'something-new', data: 'test' } },
        { type: 'unknown_thing', someData: 'blah' },
      ],
    });
    assert.ok(facts.some(f => f.type === 'process_exited'), 'turn still completes');
    const textFacts = facts.filter(f => f.type === 'assistant_text');
    assert.strictEqual(textFacts.length, 1, 'no facts from unknown events; only the final message text');
  });

  // ===========================================================================
  // 11. HTTP calls are bounded — the transport rejects an unbounded call
  // ===========================================================================
  await run('HTTP calls must carry a finite bound', async () => {
    const { HttpTransport } = require('../../../adapters/opencode/transport');
    const transport = new HttpTransport({ baseUrl: 'http://127.0.0.1:1' });
    await assert.rejects(
      () => transport.request({ method: 'GET', path: '/x' }),
      /requires a signal/,
      'an unbounded request must be rejected at the transport boundary'
    );
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
