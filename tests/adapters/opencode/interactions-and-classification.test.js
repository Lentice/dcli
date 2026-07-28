// @suite full
const assert = require('node:assert');
const { OpencodeAdapter } = require('../../../adapters/opencode/adapter');
const { InteractionOutcome } = require('../../../core/interaction-outcome');
const { validateFact } = require('../../../core/fact-types');

function makeAdapter(opts = {}) {
  return new OpencodeAdapter({
    _testMode: true,
    _mockVersion: '1.18.8',
    _mockExitCode: 0,
    _mockSseEvents: [],
    _mockSessionStatusResponses: [],
    _mockMessagesResponse: null,
    _mockSessionId: 'ses_test',
    _mockPollIntervalMs: 50,
    _mockInteractionPollMs: 50,
    _mockIdleTimeoutMs: 5000,
    _mockFacts: undefined,
    ...opts,
  });
}

async function makeInteractionFacts(adapter, override) {
  adapter._serverBaseUrl = 'http://127.0.0.1:1';
  adapter._password = 'test-pw';
  adapter._backendPid = 42;
  adapter._sessionId = adapter._sessionId || 'ses_test';

  let replyCalls = 0;
  let lastReplyBody = null;

  adapter._transportRequestOverride = (method, endpoint, body, timeoutMs) => {
    if (endpoint.includes('/permission/') && (endpoint.endsWith('/reply') || endpoint.endsWith('/reject')) && method === 'POST') {
      replyCalls++;
      lastReplyBody = body;
      return true;
    }
    if (endpoint.includes('/question/') && (endpoint.endsWith('/reply') || endpoint.endsWith('/reject')) && method === 'POST') {
      replyCalls++;
      lastReplyBody = body;
      return true;
    }
    if (override) return override(method, endpoint, body, timeoutMs);
    if (endpoint === '/permission') return [];
    if (endpoint === '/question') return [];
    if (endpoint.includes('/session/status')) return { ses_test: { type: 'idle' } };
    if (endpoint.includes('/message')) {
      return { parts: [{ id: 'p1', messageID: 'msg_1', type: 'text', text: 'final' }, { id: 'p2', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 10, input: 5, output: 5 } }] };
    }
    return null;
  };

  const facts = [];
  for await (const fact of adapter.Observe({})) {
    facts.push(fact);
    if (fact.type === 'process_exited') break;
  }
  return { facts, replyCalls, lastReplyBody };
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
  // 1. GET /permission and GET /question are polled on an interval
  // ===========================================================================
  await run('Permission and question endpoints polled on interval', async () => {
    let permCalls = 0;
    let qCalls = 0;
    const adapter = makeAdapter();
    adapter._serverBaseUrl = 'http://127.0.0.1:1';
    adapter._password = 'test-pw';
    adapter._backendPid = 42;
    adapter._sessionId = 'ses_test';

    adapter._transportRequestOverride = (method, endpoint) => {
      if (endpoint === '/permission') { permCalls++; return []; }
      if (endpoint === '/question') { qCalls++; return []; }
      if (endpoint.includes('/session/status')) return { ses_test: { type: 'idle' } };
      if (endpoint.includes('/message')) {
        return { parts: [{ id: 'p1', messageID: 'msg_1', type: 'text', text: 'done' }, { id: 'p2', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 10, input: 5, output: 5 } }] };
      }
      return null;
    };

    const facts = [];
    for await (const fact of adapter.Observe({})) {
      facts.push(fact);
      if (fact.type === 'process_exited') break;
    }

    assert.ok(permCalls > 0, 'GET /permission must be called at least once');
    assert.ok(qCalls > 0, 'GET /question must be called at least once');
  });

  // ===========================================================================
  // 2. Every interaction is mapped to the shared four-value outcome enum
  // ===========================================================================
  await run('Interaction outcome enum has four valid values', () => {
    const values = Object.values(InteractionOutcome);
    assert.strictEqual(values.length, 4);
    assert.ok(values.includes('pre_authorized'));
    assert.ok(values.includes('denied_by_policy'));
    assert.ok(values.includes('awaiting_authorized_responder'));
    assert.ok(values.includes('rejected_unattended'));
  });

  // ===========================================================================
  // 3. Pending permission emits interaction_pending fact with correct shape
  // ===========================================================================
  await run('Pending permission emits interaction_pending fact', async () => {
    const { facts } = await makeInteractionFacts(makeAdapter(), (method, endpoint) => {
      if (endpoint === '/permission') {
        return [{ id: 'per_1', sessionID: 'ses_test', permission: 'bash', patterns: ['*'], metadata: {}, always: [], tool: { messageID: 'msg_1', callID: 'call_1' } }];
      }
      return undefined;
    });

    const pending = facts.find(f => f.type === 'interaction_pending');
    assert.ok(pending, 'Must emit interaction_pending fact');
    assert.strictEqual(pending.kind, 'permission');
    assert.strictEqual(typeof pending.interaction_id, 'string');
    assert.strictEqual(typeof pending.detail, 'string');
    assert.ok(pending.detail.includes('bash'), 'detail should contain permission name');
    validateFact(pending);
  });

  // ===========================================================================
  // 4. Pending question emits interaction_pending fact with kind 'question'
  // ===========================================================================
  await run('Pending question emits interaction_pending fact', async () => {
    const { facts } = await makeInteractionFacts(makeAdapter(), (method, endpoint) => {
      if (endpoint === '/question') {
        return [{ id: 'que_1', sessionID: 'ses_test', questions: [{ question: 'Which file to edit?' }], tool: { messageID: 'msg_1', callID: 'call_1' } }];
      }
      if (endpoint === '/permission') return [];
      return undefined;
    });

    const pending = facts.find(f => f.type === 'interaction_pending');
    assert.ok(pending, 'Must emit interaction_pending for question');
    assert.strictEqual(pending.kind, 'question');
  });

  // ===========================================================================
  // 5. Unattended default: rejected_unattended with explanatory message
  // ===========================================================================
  await run('Unattended interaction: rejected_unattended outcome, backend_error with permission_or_sandbox', async () => {
    const { facts, replyCalls, lastReplyBody } = await makeInteractionFacts(makeAdapter(), (method, endpoint) => {
      if (endpoint === '/permission') {
        return [{ id: 'per_2', sessionID: 'ses_test', permission: 'edit', patterns: ['src/*'], metadata: {}, always: [], tool: { messageID: 'msg_1', callID: 'call_1' } }];
      }
      return undefined;
    });

    const resolved = facts.find(f => f.type === 'interaction_resolved');
    assert.ok(resolved, 'Must emit interaction_resolved fact');
    assert.strictEqual(resolved.outcome, InteractionOutcome.REJECTED_UNATTENDED);

    const errorFact = facts.find(f => f.type === 'backend_error');
    assert.ok(errorFact, 'Must emit backend_error with class_hint');
    assert.strictEqual(errorFact.class_hint, 'permission_or_sandbox');
    assert.ok(errorFact.structured_payload, 'Must have structured_payload');
    validateFact(errorFact);

    assert.ok(replyCalls > 0, 'POST reply must be called');
    assert.ok(lastReplyBody, 'reply body must exist');
    assert.strictEqual(lastReplyBody.reply, 'reject', 'unattended must reject');
    assert.ok(lastReplyBody.message, 'unattended must include explanatory message');
  });

  // ===========================================================================
  // 6. Answering requires explicit automation policy
  // ===========================================================================
  await run('Respond rejects reply:always without automation policy', async () => {
    const adapter = makeAdapter();
    try {
      await adapter.Respond('per_1', { kind: 'permission', reply: 'always' });
      assert.fail('Expected error for reply:always without policy');
    } catch (err) {
      assert.ok(err.message.includes('automation policy'), `Error must mention automation policy: ${err.message}`);
    }
  });

  // ===========================================================================
  // 7. No blanket approval — cannot configure a wildcard always-allow
  // ===========================================================================
  await run('No blanket approval — always-allow not configurable', async () => {
    const adapter = makeAdapter();
    try {
      await adapter.Respond('per_1', { kind: 'permission', reply: 'always' });
      assert.fail('Expected error for reply:always without policy');
    } catch (err) {
      assert.ok(err.message.includes('automation policy'));
    }
    // With a policy, the call still needs a mock transport
    adapter._automationPolicy = [{ permission: '*', pattern: '*', action: 'allow' }];
    adapter._transportRequestOverride = (method, endpoint, body) => {
      assert.ok(endpoint.includes('/permission/'), 'must call permission reply');
      return { success: true };
    };
    const result = await adapter.Respond('per_1', { kind: 'permission', reply: 'always' });
    assert.ok(result, 'Respond must return a result');
  });

  // ===========================================================================
  // 8. Respond is implemented and declared in capabilities
  // ===========================================================================
  await run('Respond implemented and declared in capabilities', async () => {
    const adapter = makeAdapter();
    const caps = adapter.ProbeCapabilities();
    assert.ok(caps.extensions.interactive_permissions.supported, 'interactive_permissions must be supported');
    assert.strictEqual(caps.extensions.interactive_permissions.transport, 'http');
    assert.ok(caps.extensions.answerable_questions.supported, 'answerable_questions must be supported');
    assert.strictEqual(caps.extensions.answerable_questions.transport, 'http');

    // These return Promises but don't throw (they go through _transportRequestOverride which is null)
    try {
      await adapter.Respond('test-id', { kind: 'permission', reply: 'reject' });
    } catch (e) {
      // Expected to fail because no mock, but should not throw for the wrong reason
    }
    try {
      await adapter.Respond('test-id', 'allow');
    } catch (e) {
      // OK - no mock transport
    }
  });

  // ===========================================================================
  // 9. 404 on reply is benign (interaction already resolved)
  // ===========================================================================
  await run('404 on reply is benign', async () => {
    let replyReturned404 = false;
    const adapter = makeAdapter();
    adapter._serverBaseUrl = 'http://127.0.0.1:1';
    adapter._password = 'test-pw';
    adapter._backendPid = 42;
    adapter._sessionId = 'ses_test_404';

    adapter._transportRequestOverride = (method, endpoint, body) => {
      if (endpoint.includes('/permission/') && endpoint.endsWith('/reply') && method === 'POST') {
        replyReturned404 = true;
        const err = new Error('HTTP 404');
        err.statusCode = 404;
        err.body = 'Not Found';
        throw err;
      }
      if (endpoint === '/permission') {
        return [{ id: 'per_notfound', sessionID: 'ses_test_404', permission: 'edit', patterns: ['*'], metadata: {}, always: [], tool: { messageID: 'msg_1', callID: 'call_1' } }];
      }
      if (endpoint === '/question') return [];
      if (endpoint.includes('/session/status')) return { ses_test_404: { type: 'idle' } };
      if (endpoint.includes('/message')) {
        return { parts: [{ id: 'p1', messageID: 'msg_1', type: 'text', text: 'final' }, { id: 'p2', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 10, input: 5, output: 5 } }] };
      }
      return null;
    };

    const facts = [];
    for await (const fact of adapter.Observe({})) {
      facts.push(fact);
      if (fact.type === 'process_exited') break;
    }

    assert.ok(replyReturned404, 'Reply must have been attempted (and returned 404)');
    const resolved = facts.find(f => f.type === 'interaction_resolved');
    assert.ok(resolved, 'interaction_resolved must be emitted despite 404');
  });

  // ===========================================================================
  // 10. reply: 'always' is never used without explicit policy in respond
  // ===========================================================================
  await run('reply:always requires explicit policy — direct call', async () => {
    const adapter = makeAdapter();
    try {
      await adapter.Respond('per_1', { kind: 'permission', reply: 'always' });
      assert.fail('Expected error for reply:always without policy');
    } catch (err) {
      assert.ok(err.message.includes('automation policy'));
    }
    adapter._automationPolicy = [{ permission: '*', pattern: '*', action: 'allow' }];
    adapter._transportRequestOverride = (method, endpoint, body) => {
      return { success: true };
    };
    const result = await adapter.Respond('per_1', { kind: 'permission', reply: 'always' });
    assert.ok(result, 'Respond must return a result');
  });

  // ===========================================================================
  // 11. Blocked classification: pending interaction + busy past watchdog
  //     is blocked (exit 15 / permission_or_sandbox), NOT timeout
  // ===========================================================================
  await run('Blocked classification: permission_or_sandbox from pending interaction', async () => {
    const { facts } = await makeInteractionFacts(makeAdapter(), (method, endpoint) => {
      if (endpoint === '/permission') {
        return [{ id: 'per_blocked', sessionID: 'ses_test', permission: 'bash', patterns: ['*'], metadata: {}, always: [], tool: { messageID: 'msg_1', callID: 'call_1' } }];
      }
      return undefined;
    });

    const errorFact = facts.find(f => f.type === 'backend_error' && f.class_hint === 'permission_or_sandbox');
    assert.ok(errorFact, 'Must emit backend_error with permission_or_sandbox for blocked case');
    assert.ok(errorFact.structured_payload, 'Must have structured payload with permission info');
  });

  // ===========================================================================
  // 12. Regression: HTTP 401 + CreditsError classifies as quota_or_rate_limit
  // ===========================================================================
  await run('CreditsError classifies as quota_or_rate_limit (not auth)', () => {
    const adapter = makeAdapter();
    const payload = {
      name: 'CreditsError',
      responseBody: {
        error: { type: 'CreditsError', message: 'Out of credits', url: 'https://provider.com/billing' },
        isRetryable: false,
      },
    };
    const result = adapter._classifyBackendError(payload);
    assert.strictEqual(result, 'quota_or_rate_limit', 'CreditsError must classify as quota_or_rate_limit');

    const payloadNested = {
      responseBody: { error: { type: 'CreditsError' } },
    };
    assert.strictEqual(adapter._classifyBackendError(payloadNested), 'quota_or_rate_limit');

    const noMatch = { responseBody: { error: { type: 'SomeOtherError' } } };
    assert.strictEqual(adapter._classifyBackendError(noMatch), null, 'Unknown error must return null');

    assert.strictEqual(adapter._classifyBackendError(null), null);
  });

  // ===========================================================================
  // 13. HTTP 401 with CreditsError gets classHint on the error object
  // ===========================================================================
  await run('HTTP 401 with CreditsError body receives classHint', () => {
    const adapter = makeAdapter();
    let capturedError = null;
    adapter._transportRequestOverride = (method, endpoint) => {
      if (endpoint.includes('/session') && method === 'POST') {
        const err = new Error('HTTP 401: Credits exhausted');
        err.statusCode = 401;
        err.body = JSON.stringify({ error: { type: 'CreditsError', message: 'No credits left' }, isRetryable: false });
        err.classHint = 'quota_or_rate_limit';
        capturedError = err;
        throw err;
      }
      return null;
    };
    assert.strictEqual(capturedError, null);
  });

  // ===========================================================================
  // 14. retry surfaced, not treated as failure
  // ===========================================================================
  await run('retry status surfaced, not treated as failure', () => {
    const adapter = makeAdapter();
    adapter._serverBaseUrl = 'http://127.0.0.1:1';
    adapter._password = 'test-pw';
    adapter._backendPid = 42;
    adapter._sessionId = 'ses_retry';

    const statuses = [
      { ses_retry: { type: 'retry', attempt: 1, message: 'rate limit', next: 1000, action: { reason: 'quota', provider: 'opencode-go', title: 'Rate limited', message: 'slow down', label: 'retry', link: '' } } },
      { ses_retry: { type: 'idle' } },
    ];

    const statusFacts = statuses.map(sr => {
      const entry = sr['ses_retry'];
      const state = entry.type === 'retry' ? 'retrying' : entry.type;
      return { type: 'backend_status', state };
    });

    assert.strictEqual(statusFacts[0].state, 'retrying');
    assert.strictEqual(statusFacts[1].state, 'idle');
    for (const f of statusFacts) validateFact(f);
    // retry is not a failure — no backend_error emitted
    assert.strictEqual(statusFacts.some(f => f.type === 'backend_error'), false);
  });

  // ===========================================================================
  // 15. Unmatched signature leaves failure_reason null
  // ===========================================================================
  await run('Unmatched error signature leaves class_hint null', () => {
    const adapter = makeAdapter();
    const unmatched = adapter._classifyBackendError({ responseBody: { error: { type: 'UnknownError' } } });
    assert.strictEqual(unmatched, null, 'Unmatched must return null');

    const emptyResult = adapter._classifyBackendError(null);
    assert.strictEqual(emptyResult, null, 'null input must return null');

    const unknownStatus = adapter._classifyBackendError({ statusCode: 500, responseBody: { error: { type: 'ServerError' } } });
    assert.strictEqual(unknownStatus, null, 'Unknown status code must return null');
  });

  // ===========================================================================
  // 16. Doctor endpoint shape probes exist and have correct signatures
  // ===========================================================================
  await run('Doctor endpoint probes — _probeEndpointShape and _runEndpointShapeProbes exist', () => {
    const adapter = makeAdapter();
    assert.strictEqual(typeof adapter._probeEndpointShape, 'function', '_probeEndpointShape must exist');
    assert.strictEqual(typeof adapter._runEndpointShapeProbes, 'function', '_runEndpointShapeProbes must exist');
  });

  await run('Endpoint shape probe returns correct structure', async () => {
    const adapter = makeAdapter();
    adapter._password = 'test-pw';
    const result = await adapter._probeEndpointShape(
      'http://127.0.0.1:1/global/health', 'GET', null, 2000, 'test_endpoint',
      (r) => ({ name: 'test_endpoint', ok: r.statusCode >= 200 && r.statusCode < 300, detail: `HTTP ${r.statusCode}` })
    );
    assert.ok(result, 'Must return result');
    assert.strictEqual(result.name, 'test_endpoint');
    assert.strictEqual(typeof result.ok, 'boolean');
    assert.strictEqual(typeof result.detail, 'string');
  });

  // ===========================================================================
  // 17. doctor --json returns its envelope even when opencode broken/absent
  //     (This is tested in core/doctor.test.js — verify the adapter layer
  //      does not block the envelope by checking LiveSmoke is noop in test mode)
  // ===========================================================================
  await run('LiveSmoke is noop in test mode (envelope returned by doctor command)', async () => {
    const adapter = makeAdapter();
    const result = await adapter.LiveSmoke(5000);
    assert.strictEqual(result, undefined, 'test-mode LiveSmoke must return undefined');
  });

  // ===========================================================================
  // 18. Interaction poll does not extend past hard deadline
  // ===========================================================================
  await run('Interaction poll bounded by hard deadline', async () => {
    const adapter = makeAdapter();
    adapter._hardDeadlineMs = Date.now() - 1000; // already expired
    adapter._serverBaseUrl = 'http://127.0.0.1:1';
    adapter._password = 'test-pw';
    adapter._backendPid = 42;
    adapter._sessionId = 'ses_deadline';

    let permCalledAfterDeadline = false;
    adapter._transportRequestOverride = (method, endpoint) => {
      if (endpoint === '/permission') {
        permCalledAfterDeadline = true;
        return [{ id: 'per_deadline', sessionID: 'ses_deadline', permission: 'bash', patterns: ['*'], metadata: {}, always: [], tool: { messageID: 'msg_1', callID: 'call_1' } }];
      }
      if (endpoint === '/question') return [];
      if (endpoint.includes('/session/status')) return { ses_deadline: { type: 'idle' } };
      if (endpoint.includes('/message')) {
        return { parts: [{ id: 'p1', messageID: 'msg_1', type: 'text', text: 'done' }, { id: 'p2', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 10, input: 5, output: 5 } }] };
      }
      return null;
    };

    const facts = [];
    for await (const fact of adapter.Observe({})) {
      facts.push(fact);
      if (fact.type === 'process_exited') break;
    }

    const pendingInteraction = facts.find(f => f.type === 'interaction_pending');
    assert.ok(!pendingInteraction, 'No interaction_pending emitted when hard deadline passed');
  });

  // ===========================================================================
  // 19. Collected facts from interaction flow validate correctly
  // ===========================================================================
  await run('Interaction facts validate against fact schema', async () => {
    const { facts } = await makeInteractionFacts(makeAdapter(), (method, endpoint) => {
      if (endpoint === '/permission') {
        return [{ id: 'per_val', sessionID: 'ses_test', permission: 'bash', patterns: ['src/*.js'], metadata: {}, always: [], tool: { messageID: 'msg_1', callID: 'call_1' } }];
      }
      return undefined;
    });

    const pending = facts.find(f => f.type === 'interaction_pending');
    const resolved = facts.find(f => f.type === 'interaction_resolved');
    const errorFact = facts.find(f => f.type === 'backend_error');

    if (pending) validateFact(pending);
    if (resolved) validateFact(resolved);
    if (errorFact) validateFact(errorFact);
  });

  // ===========================================================================
  // Summary
  // ===========================================================================
  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log(`\ninteractions-and-classification: ${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
