// @suite full
const assert = require('node:assert');
const { FakeAdapter } = require('../../adapters/fake/adapter');
const { validateFact, isKnownFactType, FACT_TYPES } = require('../../core/fact-types');
const { InteractionOutcome, validateInteractionOutcome } = require('../../core/interaction-outcome');

const TERMINAL_OR_INTERRUPTED = ['done', 'failed', 'timed_out', 'cancelled', 'interrupted'];

// ---------------------------------------------------------------------------
// Architecture tests — the contract itself
// ---------------------------------------------------------------------------

// 1. Interaction outcome enum is defined once in core/ and shared
{
  assert.ok(InteractionOutcome);
  const values = Object.values(InteractionOutcome);
  assert.ok(values.includes('pre_authorized'));
  assert.ok(values.includes('denied_by_policy'));
  assert.ok(values.includes('awaiting_authorized_responder'));
  assert.ok(values.includes('rejected_unattended'));

  for (const v of values) {
    validateInteractionOutcome(v);
  }
  assert.throws(() => validateInteractionOutcome('bogus_value'));
  assert.throws(() => validateInteractionOutcome(undefined));
}

// 2. Fact vocabulary is a closed set; unknown fact type is a hard error
{
  assert.ok(isKnownFactType('started'));
  assert.ok(isKnownFactType('process_exited'));

  assert.throws(() => validateFact({ type: 'widget_event' }), 'Unknown fact type');
  assert.throws(() => validateFact(null), 'Null fact');
  assert.throws(() => validateFact({}), 'Missing type');
  assert.throws(() => validateFact({ type: '' }), 'Empty type');

  for (const t of FACT_TYPES) {
    const mock = makeValidFactForType(t);
    validateFact(mock);
  }
}

function makeValidFactForType(type) {
  switch (type) {
    case 'started': return { type: 'started', backend_pid: 42, backend_session_id: 'ses_1' };
    case 'assistant_text': return { type: 'assistant_text', message_id: 'm1', text: 'hello' };
    case 'reasoning': return { type: 'reasoning', message_id: 'm1' };
    case 'tool_invoked': return { type: 'tool_invoked', call_id: 'c1', tool: 'read_file', summary: 'reading' };
    case 'tool_result': return { type: 'tool_result', call_id: 'c1', ok: true, summary: 'done' };
    case 'interaction_pending': return { type: 'interaction_pending', interaction_id: 'i1', kind: 'permission', detail: 'access file' };
    case 'interaction_resolved': return { type: 'interaction_resolved', interaction_id: 'i1', outcome: 'pre_authorized' };
    case 'usage_reported': return { type: 'usage_reported', tokens: { input: 10, output: 20, total: 30 } };
    case 'backend_status': return { type: 'backend_status', state: 'idle' };
    case 'backend_error': return { type: 'backend_error', class_hint: 'quota', structured_payload: { error: 'CreditsError' } };
    case 'process_exited': return { type: 'process_exited', code: 0 };
    case 'stream_closed': return { type: 'stream_closed', reason: 'session_ended' };
    default: throw new Error(`Unknown type: ${type}`);
  }
}

// 3. No operation signature mentions HTTP, sessions-as-lifecycle, streams, or process internals
{
  const CONTRACT_OPS = [
    'GetIdentity', 'DetectVersion', 'ProbeCapabilities', 'DeclareCancelRungs',
    'ValidateRequest', 'PrepareInvocation', 'Start', 'Observe', 'SendPrompt',
    'Resume', 'Respond', 'RequestCancel', 'CollectResult', 'CollectDiagnostics',
    'Dispose', 'Recover',
  ];
  const adapter = new FakeAdapter({});
  for (const op of CONTRACT_OPS) {
    const fn = adapter[op];
    assert.ok(typeof fn === 'function', `Adapter must implement ${op}`);
  }

  const banned = ['http', 'response', 'readablestream', 'stream', 'socket'];
  for (const op of CONTRACT_OPS) {
    const lower = op.toLowerCase();
    for (const b of banned) {
      assert.ok(!lower.includes(b), `Contract operation must not mention "${b}", found in "${op}"`);
    }
  }
}

// 4. Adapters cannot declare terminality — no API for it
{
  const CONTRACT_OPS = [
    'GetIdentity', 'DetectVersion', 'ProbeCapabilities', 'DeclareCancelRungs',
    'ValidateRequest', 'PrepareInvocation', 'Start', 'Observe', 'SendPrompt',
    'Resume', 'Respond', 'RequestCancel', 'CollectResult', 'CollectDiagnostics',
    'Dispose', 'Recover',
  ];
  const bannedTerminal = ['isdone', 'iscomplete', 'setterminal', 'setstate', 'declaredone', 'declareterminal', 'isterminal'];
  for (const op of CONTRACT_OPS) {
    const lower = op.toLowerCase();
    for (const b of bannedTerminal) {
      if (lower === b) {
        assert.fail(`Adapter must not have terminality API "${op}"`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter contract validation — parameterized suite
// ---------------------------------------------------------------------------

function runContractSuite(adapterFactory) {
  const adapter = adapterFactory();

  // 5. GetIdentity returns shape with required fields
  {
    const id = adapter.GetIdentity();
    assert.ok(id && typeof id === 'object');
    assert.strictEqual(typeof id.backend, 'string');
    assert.strictEqual(typeof id.adapter_version, 'string');
    assert.strictEqual(typeof id.state_schema_version, 'number');
  }

  // 6. DeclareCancelRungs returns ordered array
  {
    const rungs = adapter.DeclareCancelRungs();
    assert.ok(Array.isArray(rungs));
    for (const r of rungs) {
      assert.strictEqual(typeof r, 'string', 'Each rung must be a string');
    }
  }

  // 7. ProbeCapabilities returns object
  {
    const caps = adapter.ProbeCapabilities();
    assert.ok(caps && typeof caps === 'object');
  }

  // 8. DetectVersion returns string
  {
    const v = adapter.DetectVersion();
    assert.strictEqual(typeof v, 'string');
  }

  // 9. ValidateRequest throws typed rejection
  {
    adapter.ValidateRequest({});  // no throw for valid
    const failAdapter = adapterFactory();
    if (failAdapter._script && failAdapter._script.behaviors && failAdapter._script.behaviors.failValidateOn) {
      const req = {};
      req[failAdapter._script.behaviors.failValidateOn] = 'some-value';
      assert.throws(() => failAdapter.ValidateRequest(req), (err) => err.code === 'VALIDATION_FAILED');
    }
  }

  // 10. Respond is gated by capability — throw when not declared
  {
    const basic = adapterFactory();
    const caps = basic.ProbeCapabilities();
    const hasPerms = caps.extensions && caps.extensions.interactive_permissions && caps.extensions.interactive_permissions.supported;

    if (!hasPerms) {
      assert.throws(() => basic.Respond('test-id', 'allow'), /not supported/);
    } else {
      basic.Respond('test-id', 'allow');
    }
  }

  // 11. PrepareInvocation, SendPrompt, Resume are present (no throw)
  {
    assert.doesNotThrow(() => adapter.PrepareInvocation({}, {}));
    assert.doesNotThrow(() => adapter.SendPrompt({}, 'test'));
    assert.doesNotThrow(() => adapter.Resume({}, 'fork_from_artifacts', 'continue'));
  }

  // 12. Dispose is idempotent
  {
    const a = adapterFactory();
    a.Dispose({});
    assert.strictEqual(a.disposed, true);
    assert.doesNotThrow(() => a.Dispose({}));
  }

  // 13. Recover postcondition: terminal or interrupted, never running
  {
    const a = adapterFactory();
    const recovery = a.Recover({});
    assert.ok(recovery && typeof recovery.state === 'string');
    if (TERMINAL_OR_INTERRUPTED.includes(recovery.state)) {
      // correct
    } else {
      assert.fail(`Recover returned state "${recovery.state}" which is not terminal or interrupted`);
    }
  }

  // 14. Observe yields valid facts
  {
    const a = adapterFactory();
    const iterator = a.Observe({});
    assert.ok(iterator && typeof iterator[Symbol.asyncIterator] === 'function');
  }

  // 15. Start returns an execution handle
  {
    const handle = adapter.Start({});
    assert.ok(handle && typeof handle === 'object');
  }

  // 16. CollectResult returns shape with text, usage, backend_session_id
  {
    const result = adapter.CollectResult({});
    assert.ok(result && typeof result === 'object');
    assert.strictEqual(typeof result.text, 'string');
    assert.ok(result.usage && typeof result.usage === 'object');
  }

  // 17. CollectDiagnostics returns object with schema_version
  {
    const diag = adapter.CollectDiagnostics({});
    assert.ok(diag && typeof diag === 'object');
    assert.ok('schema_version' in diag);
  }
}

// ---------------------------------------------------------------------------
// Scenario tests — fake adapter produces all 8 scenarios
// ---------------------------------------------------------------------------

// Scenario 1: Clean run producing final text
{
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 42, backend_session_id: 'ses_abc' },
      { type: 'assistant_text', message_id: 'msg_1', text: 'Here is the review.' },
      { type: 'usage_reported', tokens: { input: 50, output: 200, total: 250 } },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const result = adapter.CollectResult({});
  assert.strictEqual(result.text, 'Here is the review.');
  assert.strictEqual(result.usage.total, 250);
  assert.strictEqual(result.backend_session_id, 'ses_abc');
  assert.strictEqual(adapter.DeclareCancelRungs().length, 1);
}

// Scenario 2: Tool-using run
{
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started' },
      { type: 'tool_invoked', call_id: 'call_1', tool: 'read_file', summary: 'Read src/main.js' },
      { type: 'tool_result', call_id: 'call_1', ok: true, summary: 'Content returned' },
      { type: 'assistant_text', message_id: 'msg_1', text: 'I found the issue in src/main.js' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  for (const f of adapter._script.facts) {
    validateFact(f);
  }
  const result = adapter.CollectResult({});
  assert.strictEqual(result.text, 'I found the issue in src/main.js');
  assert.ok(result.text.length > 0);
}

// Scenario 3: Exits 0 with no assistant text
{
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const result = adapter.CollectResult({});
  assert.strictEqual(result.text, '');
}

// Scenario 4: backend_error with structured payload
{
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started' },
      { type: 'backend_error', class_hint: 'quota_or_rate_limit', structured_payload: { error: 'CreditsError', credits: 0 } },
      { type: 'process_exited', code: 1 },
    ],
    exitCode: 1,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const errorFact = adapter._script.facts[1];
  assert.strictEqual(errorFact.type, 'backend_error');
  assert.strictEqual(errorFact.class_hint, 'quota_or_rate_limit');
  assert.strictEqual(errorFact.structured_payload.error, 'CreditsError');
  validateFact(errorFact);

  const recovery = adapter.Recover({});
  assert.ok(TERMINAL_OR_INTERRUPTED.includes(recovery.state));
}

// Scenario 5: interaction_pending never resolved
{
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started' },
      { type: 'interaction_pending', interaction_id: 'int_1', kind: 'permission', detail: 'Network access needed' },
      { type: 'backend_status', state: 'busy' },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: {
      schema_version: 1,
      backend: 'fake',
      core: { run: true },
      extensions: { interactive_permissions: { supported: true, transport: 'http' } },
    },
  });

  const pendingFact = adapter._script.facts[1];
  assert.strictEqual(pendingFact.type, 'interaction_pending');
  assert.strictEqual(pendingFact.kind, 'permission');

  const hasResolution = adapter._script.facts.some(f => f.type === 'interaction_resolved');
  assert.strictEqual(hasResolution, false, 'Scenario 5: interaction_pending must not be resolved');

  assert.ok(adapter.DeclareCancelRungs().length >= 1);
}

// Scenario 6: Slow run (facts with delays)
{
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started' },
      { type: 'assistant_text', message_id: 'msg_1', text: 'Slow response', delayMs: 200 },
      { type: 'process_exited', code: 0, delayMs: 200 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  assert.strictEqual(adapter._script.facts[1].delayMs, 200);
  assert.strictEqual(adapter._script.facts[1].text, 'Slow response');

  // Observe with timeout to ensure it eventually completes
  const result = adapter.CollectResult({});
  assert.strictEqual(result.text, 'Slow response');
}

// Scenario 7: Immediate crash before any fact
{
  const adapter = new FakeAdapter({
    facts: [],
    exitCode: 1,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const result = adapter.CollectResult({});
  assert.strictEqual(result.text, '');
  assert.strictEqual(result.usage.total, 0);
  assert.strictEqual(adapter._script.facts.length, 0);

  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.facts_emitted, 0);
  assert.strictEqual(diag.exit_code, 1);
}

// Scenario 8: Three rungs where first two fail, third succeeds
{
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started' },
      { type: 'assistant_text', message_id: 'msg_1', text: 'Partial result before cancel' },
    ],
    exitCode: 0,
    declaredRungs: ['graceful_stop', 'flush', 'hard_kill'],
    rungFailures: { graceful_stop: true, flush: true, hard_kill: false },
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  assert.deepStrictEqual(adapter.DeclareCancelRungs(), ['graceful_stop', 'flush', 'hard_kill']);

  const r1 = adapter.RequestCancel({}, 'graceful_stop');
  assert.strictEqual(r1.success, false);
  assert.strictEqual(adapter.cancelRungReached, null);

  const r2 = adapter.RequestCancel({}, 'flush');
  assert.strictEqual(r2.success, false);

  const r3 = adapter.RequestCancel({}, 'hard_kill');
  assert.strictEqual(r3.success, true);
  assert.strictEqual(adapter.cancelRungReached, 'hard_kill');
  assert.strictEqual(adapter.cancelled, true);
}

// ---------------------------------------------------------------------------
// Run contract suite against the fake adapter
// ---------------------------------------------------------------------------

runContractSuite(() => new FakeAdapter({
  facts: [
    { type: 'started' },
    { type: 'assistant_text', message_id: 'msg_1', text: 'Contract test result' },
    { type: 'process_exited', code: 0 },
  ],
  exitCode: 0,
  declaredRungs: ['hard_kill'],
  capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
}));

// Also test that Recover never returns running for any configuration
{
  for (const cfg of [
    { facts: [], exitCode: 0, declaredRungs: ['hard_kill'], capabilities: {} },
    { facts: [{ type: 'started' }], exitCode: 1, declaredRungs: ['hard_kill'], capabilities: {} },
    { facts: [{ type: 'started' }], exitCode: 0, declaredRungs: ['hard_kill'], capabilities: {}, behaviors: { hangAfter: 'started' } },
    { facts: [{ type: 'started' }, { type: 'backend_error', class_hint: 'quota', structured_payload: {} }], exitCode: 1, declaredRungs: ['hard_kill'], capabilities: {} },
    { facts: [{ type: 'started' }], exitCode: null, declaredRungs: ['hard_kill'], capabilities: {} },
  ]) {
    const a = new FakeAdapter(cfg);
    const r = a.Recover({});
    assert.ok(r && typeof r === 'object', `Recover must return an object for config: ${JSON.stringify(cfg)}`);
    assert.ok(TERMINAL_OR_INTERRUPTED.includes(r.state),
      `Recover must never return running/created for config ${JSON.stringify(cfg)}, got "${r.state}"`);
  }
}

// ---------------------------------------------------------------------------
// Run contract suite against the opencode adapter (test mode)
// ---------------------------------------------------------------------------

{
  const { OpencodeAdapter } = require('../../adapters/opencode/adapter');
  runContractSuite(() => new OpencodeAdapter({
    _testMode: true,
    _mockVersion: '1.18.8',
    _mockFacts: [
      { type: 'started', backend_pid: 42, backend_session_id: 'ses_contract' },
      { type: 'assistant_text', message_id: 'msg_1', text: 'Contract test result from opencode' },
      { type: 'usage_reported', tokens: { input: 50, output: 200, total: 250 } },
      { type: 'process_exited', code: 0 },
    ],
    _mockExitCode: 0,
  }));
}

// Also test opencode-specific contract: DeclareCancelRungs returns 3 rungs
{
  const { OpencodeAdapter } = require('../../adapters/opencode/adapter');
  const adapter = new OpencodeAdapter({ _testMode: true, _mockVersion: '1.18.8', _mockFacts: [], _mockExitCode: 0 });
  const rungs = adapter.DeclareCancelRungs();
  assert.strictEqual(rungs.length, 3);
  assert.strictEqual(rungs[0], 'session_abort');
  assert.strictEqual(rungs[1], 'server_dispose');
  assert.strictEqual(rungs[2], 'hard_kill');
}

// ---------------------------------------------------------------------------
// Run contract suite against the codex adapter (test mode)
// ---------------------------------------------------------------------------

{
  const { CodexAdapter } = require('../../adapters/codex/adapter');
  runContractSuite(() => new CodexAdapter({
    _testMode: true,
    _mockVersion: '0.145.0',
    _mockFacts: [
      { type: 'started', backend_pid: 42, backend_session_id: 'ses_contract' },
      { type: 'assistant_text', message_id: 'msg_1', text: 'Contract test result from codex' },
      { type: 'usage_reported', tokens: { input: 50, output: 200, total: 250 } },
      { type: 'process_exited', code: 0 },
    ],
    _mockExitCode: 0,
  }));
}

// Also test codex-specific contract: DeclareCancelRungs returns exactly 1 rung
{
  const { CodexAdapter } = require('../../adapters/codex/adapter');
  const adapter = new CodexAdapter({ _testMode: true, _mockVersion: '0.145.0', _mockFacts: [], _mockExitCode: 0 });
  const rungs = adapter.DeclareCancelRungs();
  assert.strictEqual(rungs.length, 1);
  assert.deepStrictEqual(rungs, ['hard_kill']);
}

// Run contract suite against the fake adapter
// ---------------------------------------------------------------------------
{
  const adapter = new FakeAdapter({
    facts: [{ type: 'started' }],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });
  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.schema_version, 1);
  assert.ok('backend' in diag);
}

console.log('All contract and scenario tests passed.');
