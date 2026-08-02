// @suite full
const assert = require('node:assert');
const { ClaudeAdapter, buildArgv, EFFORT_LEVELS } = require('../../../adapters/claude/adapter');

const TERMINAL_OR_INTERRUPTED = ['done', 'failed', 'timed_out', 'cancelled', 'interrupted'];

function makeMinimalAdapter() {
  return new ClaudeAdapter({
    _testMode: true,
    _mockVersion: '2.1.220',
    _mockFacts: [
      { type: 'started', backend_pid: 42, backend_session_id: 'ses_test' },
      { type: 'assistant_text', message_id: 'msg_1', text: 'Hello from claude' },
      { type: 'usage_reported', tokens: { input: 50, output: 200, total: 250 } },
      { type: 'process_exited', code: 0 },
    ],
    _mockExitCode: 0,
  });
}

async function main() {

// ===========================================================================
// 1. GetIdentity returns correct shape
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const id = adapter.GetIdentity();
  assert.strictEqual(id.backend, 'claude');
  assert.strictEqual(typeof id.adapter_version, 'string');
  assert.strictEqual(typeof id.state_schema_version, 'number');
  console.log('PASS: GetIdentity returns correct shape');
}

// ===========================================================================
// 2. DetectVersion returns version string
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const v = adapter.DetectVersion();
  assert.strictEqual(typeof v, 'string');
  assert.ok(v.length > 0);
  console.log('PASS: DetectVersion returns version');
}

// ===========================================================================
// 3. ProbeCapabilities returns required fields
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const caps = adapter.ProbeCapabilities();
  assert.strictEqual(caps.backend, 'claude');
  assert.strictEqual(caps.schema_version, 1);
  assert.ok(caps.core);
  assert.ok(caps.extensions);
  // Check unused extensions are declared with reasons
  assert.ok(caps.extensions.json_schema_output);
  assert.ok(caps.extensions.json_schema_output.reason);
  assert.ok(caps.extensions.native_worktree);
  assert.ok(caps.extensions.native_background_jobs);
  // Check recursion guard is declared
  assert.ok(caps.extensions.recursion_guard);
  assert.strictEqual(caps.extensions.recursion_guard.depth_limit, 1);
  console.log('PASS: ProbeCapabilities returns complete manifest');
}

// ===========================================================================
// 4. DeclareCancelRungs returns hard_kill only
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  assert.deepStrictEqual(adapter.DeclareCancelRungs(), ['hard_kill']);
  console.log('PASS: DeclareCancelRungs');
}

// ===========================================================================
// 5. ValidateRequest rejects --variant
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  assert.throws(() => adapter.ValidateRequest({ variant: 'test' }), /not supported/);
  console.log('PASS: ValidateRequest rejects --variant');
}

// ===========================================================================
// 6. Respond throws not-supported
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  assert.throws(() => adapter.Respond('id', 'allow'), /not supported/);
  console.log('PASS: Respond throws not-supported');
}

// ===========================================================================
// 7. Contract operations exist
// ===========================================================================
{
  const operations = [
    'GetIdentity', 'DetectVersion', 'ProbeCapabilities', 'DeclareCancelRungs',
    'ValidateRequest', 'PrepareInvocation', 'Start', 'Observe', 'SendPrompt',
    'Resume', 'Respond', 'RequestCancel', 'CollectResult', 'CollectDiagnostics',
    'Dispose', 'Recover', 'LiveSmoke',
  ];
  const adapter = makeMinimalAdapter();
  for (const op of operations) {
    assert.strictEqual(typeof adapter[op], 'function', `Adapter must implement ${op}`);
  }
  console.log('PASS: All contract operations implemented');
}

// ===========================================================================
// 8. Start returns handle with sessionId
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const handle = await adapter.Start({});
  assert.ok(handle, 'Start must return handle');
  assert.ok(handle.handle, 'Handle must have a handle property');
  console.log('PASS: Start returns handle');
}

// ===========================================================================
// 9. Observe yields facts
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const facts = [];
  for await (const fact of adapter.Observe({})) {
    facts.push(fact);
  }
  assert.ok(facts.length > 0, 'Must yield at least one fact');
  console.log('PASS: Observe yields facts');
}

// ===========================================================================
// 10. CollectResult returns shape
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const result = adapter.CollectResult({});
  assert.strictEqual(typeof result.text, 'string');
  assert.ok(result.usage);
  assert.strictEqual(typeof result.usage.total, 'number');
  assert.strictEqual(result.result_status, 'missing');
  console.log('PASS: CollectResult returns results');
}

// ===========================================================================
// 11. Dispose is idempotent
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  adapter.Dispose({});
  assert.strictEqual(adapter.disposed, true);
  adapter.Dispose({});
  assert.strictEqual(adapter.disposed, true);
  console.log('PASS: Dispose is idempotent');
}

// ===========================================================================
// 12. Recover returns terminal or interrupted
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const recovery = adapter.Recover({});
  assert.ok(recovery && typeof recovery.state === 'string');
  assert.ok(TERMINAL_OR_INTERRUPTED.includes(recovery.state));
  console.log('PASS: Recover returns terminal state');
}

// ===========================================================================
// 13. CollectDiagnostics returns shape
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.schema_version, 1);
  assert.strictEqual(diag.backend, 'claude');
  console.log('PASS: CollectDiagnostics returns shape');
}

// ===========================================================================
// 14. buildArgv constructs correct arg array
// ===========================================================================
{
  const argv = buildArgv({
    sessionId: 'test-uuid',
    permissionMode: 'auto',
    safeMode: true,
    // Keep this a cheap argv-shape test; production's $20 budget is not a
    // contract of buildArgv and must not be spent by the test suite.
    maxBudgetUsd: 0.01,
    model: 'sonnet',
    effort: 'high',
    addDirs: ['/extra/dir'],
  });
  assert.ok(argv.includes('-p'), 'Must include -p');
  assert.ok(argv.includes('--output-format'), 'Must include output format');
  assert.ok(argv.includes('stream-json'), 'Must use stream-json');
  assert.ok(argv.includes('--session-id'), 'Must include session-id');
  assert.ok(argv.includes('test-uuid'), 'Must include session id value');
  assert.ok(argv.includes('--safe-mode'), 'Must include safe-mode');
  assert.ok(argv.includes('--disable-slash-commands'), 'Must disable slash commands');
  // Sessions must be persisted: --no-session-persistence and resume are
  // mutually exclusive, and this adapter declares core.resume and hands back a
  // backend_session_id that continue_backend_session is expected to continue.
  assert.ok(!argv.includes('--no-session-persistence'),
    'must not disable persistence — it makes the recorded session id unresumable');
  assert.ok(argv.includes('--model'), 'Must include model flag');
  assert.ok(argv.includes('sonnet'), 'Must include model value');
  assert.ok(argv.includes('--add-dir'), 'Must include add-dir');
  assert.ok(argv.includes('/extra/dir'), 'Must include add-dir value');
  console.log('PASS: buildArgv constructs correct args');
}

// ===========================================================================
// 15. Resume stores resume kind
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  adapter.Resume({}, 'continue_backend_session', 'follow-up');
  assert.strictEqual(adapter._resumeKind, 'continue_backend_session');
  assert.strictEqual(adapter._resumePrompt, 'follow-up');
  console.log('PASS: Resume stores kind');
}

// ===========================================================================
// 16. EFFORT_LEVELS is correct
// ===========================================================================
{
  assert.ok(EFFORT_LEVELS.has('low'));
  assert.ok(EFFORT_LEVELS.has('medium'));
  assert.ok(EFFORT_LEVELS.has('high'));
  assert.ok(EFFORT_LEVELS.has('xhigh'));
  assert.ok(EFFORT_LEVELS.has('max'));
  assert.strictEqual(EFFORT_LEVELS.size, 5);
  console.log('PASS: EFFORT_LEVELS correctly defined');
}

// ===========================================================================
// 17. RequestCancel handles unknown rung
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const result = await adapter.RequestCancel({}, 'graceful_stop');
  assert.strictEqual(result.success, false);
  assert.ok(result.error);
  console.log('PASS: RequestCancel rejects unknown rung');
}

// ===========================================================================
// 18. RequestCancel with hard_kill succeeds
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const result = await adapter.RequestCancel({}, 'hard_kill');
  assert.strictEqual(result.success, true);
  assert.strictEqual(adapter.cancelled, true);
  assert.strictEqual(adapter.cancelRungReached, 'hard_kill');
  console.log('PASS: RequestCancel hard_kill succeeds');
}

console.log('All claude adapter tests passed.');
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
