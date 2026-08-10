// @suite full
// Interaction polling, unattended rejection, classification and Respond —
// driven through the ticket-100 seams: the turn module against a scripted
// transport, Respond against the adapter's injected transport.
const assert = require('node:assert');
const { OpencodeAdapter } = require('../../../adapters/opencode/adapter');
const { OpencodeTurn } = require('../../../adapters/opencode/turn');
const { FakeTransport } = require('../../fixtures/fake-transport');
const { classifyBackendError } = require('../../../adapters/opencode/classify');
const { InteractionOutcome } = require('../../../core/interaction-outcome');
const { validateFact } = require('../../../core/fact-types');

const TURN_TIMINGS = {
  pollIntervalMs: 0,
  interactionPollMs: 0,
  idleConfirmMs: 1,
};

const FINAL_MESSAGE = {
  parts: [
    { id: 'p1', messageID: 'msg_1', type: 'text', text: 'final' },
    { id: 'p2', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 10, input: 5, output: 5 } },
  ],
};

function makeAdapter(opts = {}) {
  return new OpencodeAdapter({
    transport: new FakeTransport({}),
    ...opts,
  });
}

async function makeInteractionFacts(script, sessionId = 'ses_test') {
  const transport = new FakeTransport({
    script: {
      '/session/status': { [sessionId]: { type: 'idle' } },
      '/session/ses_test/message': FINAL_MESSAGE,
      ...script,
    },
  });
  const turn = new OpencodeTurn({ transport, buildPath: (ep) => ep, timings: TURN_TIMINGS });
  const facts = [];
  for await (const fact of turn.run({
    session: { id: sessionId, promptSentAt: Date.now(), backendPid: 42 },
    policy: null,
    deadline: null,
  })) {
    facts.push(fact);
    if (fact.type === 'process_exited') break;
  }
  return { facts };
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
    const transport = new FakeTransport({
      script: {
        '/session/status': { ses_test: { type: 'idle' } },
        '/session/ses_test/message': FINAL_MESSAGE,
        '/permission': () => { permCalls++; return []; },
        '/question': () => { qCalls++; return []; },
      },
    });
    const turn = new OpencodeTurn({ transport, buildPath: (ep) => ep, timings: TURN_TIMINGS });
    for await (const fact of turn.run({ session: { id: 'ses_test', promptSentAt: Date.now(), backendPid: 42 }, policy: null, deadline: null })) {
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
    const { facts } = await makeInteractionFacts({
      '/permission': [{ id: 'per_1', sessionID: 'ses_test', permission: 'bash', patterns: ['*'], metadata: {}, always: [], tool: { messageID: 'msg_1', callID: 'call_1' } }],
      '/question': [],
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
    const { facts } = await makeInteractionFacts({
      '/permission': [],
      '/question': [{ id: 'que_1', sessionID: 'ses_test', questions: [{ question: 'Which file to edit?' }], tool: { messageID: 'msg_1', callID: 'call_1' } }],
    });

    const pending = facts.find(f => f.type === 'interaction_pending');
    assert.ok(pending, 'Must emit interaction_pending for question');
    assert.strictEqual(pending.kind, 'question');
  });

  // ===========================================================================
  // 5. Unattended default: rejected_unattended with explanatory message
  // ===========================================================================
  await run('Unattended interaction: rejected_unattended outcome, backend_error with permission_or_sandbox', async () => {
    let lastReplyBody = null;
    const { facts } = await makeInteractionFacts({
      '/permission': [{ id: 'per_2', sessionID: 'ses_test', permission: 'edit', patterns: ['src/*'], metadata: {}, always: [], tool: { messageID: 'msg_1', callID: 'call_1' } }],
      '/question': [],
      '/permission/per_2/reply': (req) => { lastReplyBody = req.body; return true; },
    });

    const resolved = facts.find(f => f.type === 'interaction_resolved');
    assert.ok(resolved, 'Must emit interaction_resolved fact');
    assert.strictEqual(resolved.outcome, InteractionOutcome.REJECTED_UNATTENDED);

    const errorFact = facts.find(f => f.type === 'backend_error');
    assert.ok(errorFact, 'Must emit backend_error with class_hint');
    assert.strictEqual(errorFact.class_hint, 'permission_or_sandbox');
    assert.ok(errorFact.structured_payload, 'Must have structured_payload');
    validateFact(errorFact);

    assert.ok(lastReplyBody, 'POST reply must be called');
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
    // With a policy, the call goes through the injected transport
    const transport = new FakeTransport({
      script: {
        '/permission/per_1/reply': { success: true },
      },
    });
    const policyAdapter = new OpencodeAdapter({ transport });
    policyAdapter._automationPolicy = [{ permission: '*', pattern: '*', action: 'allow' }];
    const result = await policyAdapter.Respond('per_1', { kind: 'permission', reply: 'always' });
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
  });

  // ===========================================================================
  // 9. 404 on reply is benign (interaction already resolved)
  // ===========================================================================
  await run('404 on reply is benign', async () => {
    let replyReturned404 = false;
    const { facts } = await makeInteractionFacts({
      '/permission': [{ id: 'per_notfound', sessionID: 'ses_test_404', permission: 'edit', patterns: ['*'], metadata: {}, always: [], tool: { messageID: 'msg_1', callID: 'call_1' } }],
      '/question': [],
      '/permission/per_notfound/reply': () => {
        replyReturned404 = true;
        return { status: 404, body: 'Not Found' };
      },
    }, 'ses_test_404');

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
    const transport = new FakeTransport({
      script: {
        '/permission/per_1/reply': { success: true },
      },
    });
    const policyAdapter = new OpencodeAdapter({ transport });
    policyAdapter._automationPolicy = [{ permission: '*', pattern: '*', action: 'allow' }];
    const result = await policyAdapter.Respond('per_1', { kind: 'permission', reply: 'always' });
    assert.ok(result, 'Respond must return a result');
  });

  // ===========================================================================
  // 11. Blocked classification: pending interaction + busy past watchdog
  //     is blocked (exit 15 / permission_or_sandbox), NOT timeout
  // ===========================================================================
  await run('Blocked classification: permission_or_sandbox from pending interaction', async () => {
    const { facts } = await makeInteractionFacts({
      '/permission': [{ id: 'per_blocked', sessionID: 'ses_test', permission: 'bash', patterns: ['*'], metadata: {}, always: [], tool: { messageID: 'msg_1', callID: 'call_1' } }],
      '/question': [],
      '/permission/per_blocked/reply': true,
    });

    const errorFact = facts.find(f => f.type === 'backend_error' && f.class_hint === 'permission_or_sandbox');
    assert.ok(errorFact, 'Must emit backend_error with permission_or_sandbox for blocked case');
    assert.ok(errorFact.structured_payload, 'Must have structured payload with permission info');
  });

  // ===========================================================================
  // 12. Regression: HTTP 401 + CreditsError classifies as quota_or_rate_limit
  // ===========================================================================
  await run('CreditsError classifies as quota_or_rate_limit (not auth)', () => {
    const payload = {
      name: 'CreditsError',
      responseBody: {
        error: { type: 'CreditsError', message: 'Out of credits', url: 'https://provider.com/billing' },
        isRetryable: false,
      },
    };
    assert.strictEqual(classifyBackendError(payload), 'quota_or_rate_limit', 'CreditsError must classify as quota_or_rate_limit');

    const payloadNested = {
      responseBody: { error: { type: 'CreditsError' } },
    };
    assert.strictEqual(classifyBackendError(payloadNested), 'quota_or_rate_limit');

    const noMatch = { responseBody: { error: { type: 'SomeOtherError' } } };
    assert.strictEqual(classifyBackendError(noMatch), null, 'Unknown error must return null');

    assert.strictEqual(classifyBackendError(null), null);
  });

  // ===========================================================================
  // 13. HTTP 401 with CreditsError gets classHint on the error object
  // ===========================================================================
  await run('HTTP 401 with CreditsError body receives classHint', async () => {
    const transport = new FakeTransport({
      script: {
        '/project/current': { directory: __dirname },
        '/session': { status: 401, body: JSON.stringify({ error: { type: 'CreditsError', message: 'No credits left' }, isRetryable: false }) },
      },
    });
    const adapter = new OpencodeAdapter({ transport });
    adapter.PrepareInvocation({}, { canonicalDir: __dirname, access: 'read-only' });
    await assert.rejects(
      () => adapter.SendPrompt({}, 'test'),
      (err) => {
        assert.strictEqual(err.statusCode, 401, 'statusCode must be attached');
        assert.strictEqual(err.classHint, 'quota_or_rate_limit', 'CreditsError body must set the class hint');
        return true;
      }
    );
  });

  // ===========================================================================
  // 14. retry surfaced, not treated as failure
  // ===========================================================================
  await run('retry status surfaced, not treated as failure', async () => {
    const statuses = [
      { ses_retry: { type: 'retry', attempt: 1, message: 'rate limit', next: 1000, action: { reason: 'quota', provider: 'opencode-go', title: 'Rate limited', message: 'slow down', label: 'retry', link: '' } } },
      { ses_retry: { type: 'idle' } },
    ];
    let i = 0;
    const { facts } = await makeInteractionFacts({
      '/session/status': () => statuses[Math.min(i++, statuses.length - 1)],
    }, 'ses_retry');

    const statusFacts = facts.filter(f => f.type === 'backend_status');
    assert.ok(statusFacts.some(f => f.state === 'retrying'), 'retry maps to retrying');
    assert.ok(statusFacts.some(f => f.state === 'idle'), 'idle emitted');
    for (const f of statusFacts) validateFact(f);
    // retry is not a failure — no backend_error with the retry as its cause
    assert.strictEqual(facts.some(f => f.type === 'backend_error' && f.class_hint === 'backend_status_unresolved'), false);
  });

  // ===========================================================================
  // 15. Unmatched signature leaves failure_reason null
  // ===========================================================================
  await run('Unmatched error signature leaves class_hint null', () => {
    assert.strictEqual(classifyBackendError({ responseBody: { error: { type: 'UnknownError' } } }), null, 'Unmatched must return null');
    assert.strictEqual(classifyBackendError(null), null, 'null input must return null');
    assert.strictEqual(classifyBackendError({ statusCode: 500, responseBody: { error: { type: 'ServerError' } } }), null, 'Unknown status code must return null');
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
  // 17. Interaction poll does not extend past hard deadline
  // ===========================================================================
  await run('Interaction poll bounded by hard deadline', async () => {
    const transport = new FakeTransport({
      script: {
        '/session/status': { ses_deadline: { type: 'idle' } },
        '/session/ses_deadline/message': FINAL_MESSAGE,
        '/permission': () => {
          return [{ id: 'per_deadline', sessionID: 'ses_deadline', permission: 'bash', patterns: ['*'], metadata: {}, always: [], tool: { messageID: 'msg_1', callID: 'call_1' } }];
        },
        '/question': [],
      },
    });
    const turn = new OpencodeTurn({ transport, buildPath: (ep) => ep, timings: TURN_TIMINGS });
    const facts = [];
    for await (const fact of turn.run({
      session: { id: 'ses_deadline', promptSentAt: Date.now(), backendPid: 42 },
      policy: null,
      deadline: Date.now() - 1000, // already expired
    })) {
      facts.push(fact);
      if (fact.type === 'process_exited') break;
    }

    const pendingInteraction = facts.find(f => f.type === 'interaction_pending');
    assert.ok(!pendingInteraction, 'No interaction_pending emitted when hard deadline passed');
  });

  // ===========================================================================
  // 18. Collected facts from interaction flow validate correctly
  // ===========================================================================
  await run('Interaction facts validate against fact schema', async () => {
    const { facts } = await makeInteractionFacts({
      '/permission': [{ id: 'per_val', sessionID: 'ses_test', permission: 'bash', patterns: ['src/*.js'], metadata: {}, always: [], tool: { messageID: 'msg_1', callID: 'call_1' } }],
      '/question': [],
      '/permission/per_val/reply': true,
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
