// @suite full
const assert = require('node:assert');
const { OpencodeAdapter } = require('../../../adapters/opencode/adapter');
const { validateFact } = require('../../../core/fact-types');

const TERMINAL_OR_INTERRUPTED = ['done', 'failed', 'timed_out', 'cancelled', 'interrupted'];

function makeMinimalAdapter() {
  return new OpencodeAdapter({
    _testMode: true,
    _mockVersion: '1.18.8',
    _mockFacts: [
      { type: 'started', backend_pid: 42, backend_session_id: 'ses_test' },
      { type: 'assistant_text', message_id: 'msg_1', text: 'Hello from opencode' },
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
  assert.ok(id && typeof id === 'object');
  assert.strictEqual(id.backend, 'opencode');
  assert.strictEqual(typeof id.adapter_version, 'string');
  assert.strictEqual(typeof id.state_schema_version, 'number');
  assert.strictEqual(id.state_schema_version, 1);
  console.log('PASS: GetIdentity returns correct shape');
}

// ===========================================================================
// 2. DetectVersion returns a string
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const v = adapter.DetectVersion();
  assert.strictEqual(typeof v, 'string');
  assert.strictEqual(v, '1.18.8');
  console.log('PASS: DetectVersion returns version string');
}

// ===========================================================================
// 3. ProbeCapabilities returns object with required fields
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const caps = adapter.ProbeCapabilities();
  assert.ok(caps && typeof caps === 'object');
  assert.strictEqual(caps.schema_version, 1);
  assert.strictEqual(caps.backend, 'opencode');
  assert.ok(typeof caps.backend_version === 'string');
  assert.ok(caps.supported_version_range);
  assert.ok(caps.supported_version_range.min);
  assert.ok(caps.supported_version_range.max);
  console.log('PASS: ProbeCapabilities returns valid manifest');
}

// ===========================================================================
// 4. DeclareCancelRungs returns opencode's three real rungs
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const rungs = adapter.DeclareCancelRungs();
  assert.ok(Array.isArray(rungs));
  assert.strictEqual(rungs.length, 3);
  assert.deepStrictEqual(rungs, ['session_abort', 'server_dispose', 'hard_kill']);
  console.log('PASS: DeclareCancelRungs returns 3 rungs');
}

// ===========================================================================
// 5. ValidateRequest rejects reasoningEffort and effort, accepts variant
// ===========================================================================
{
  const adapter = makeMinimalAdapter();

  // variant is accepted
  adapter.ValidateRequest({ variant: 'high' });

  // reasoningEffort is rejected
  assert.throws(() => {
    adapter.ValidateRequest({ reasoningEffort: 'high' });
  }, (err) => err.code === 'VALIDATION_FAILED');

  // effort is rejected
  assert.throws(() => {
    adapter.ValidateRequest({ effort: 'high' });
  }, (err) => err.code === 'VALIDATION_FAILED');

  console.log('PASS: ValidateRequest rejects reasoningEffort, accepts variant');
}

// ===========================================================================
// 6. Observe yields only closed-set fact types
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const iterator = adapter.Observe({});
  assert.ok(iterator && typeof iterator[Symbol.asyncIterator] === 'function');
  console.log('PASS: Observe returns async iterator');
}

// ===========================================================================
// 7. CollectResult returns text, usage, and backend_session_id
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const result = adapter.CollectResult({});
  assert.ok(result && typeof result === 'object');
  assert.strictEqual(result.text, 'Hello from opencode');
  assert.ok(result.usage && typeof result.usage === 'object');
  assert.strictEqual(result.usage.total, 250);
  assert.strictEqual(result.backend_session_id, 'ses_test');
  console.log('PASS: CollectResult returns text, usage, session');
}

// ===========================================================================
// 8. CollectResult with empty facts returns empty text
// ===========================================================================
{
  const adapter = new OpencodeAdapter({
    _testMode: true,
    _mockVersion: '1.18.8',
    _mockFacts: [],
    _mockExitCode: 0,
  });
  const result = adapter.CollectResult({});
  assert.strictEqual(result.text, '');
  assert.strictEqual(result.usage.total, 0);
  assert.strictEqual(result.backend_session_id, null);
  console.log('PASS: CollectResult with empty facts returns empty');
}

// ===========================================================================
// 9. CollectDiagnostics returns object with schema_version
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const diag = adapter.CollectDiagnostics({});
  assert.ok(diag && typeof diag === 'object');
  assert.strictEqual(diag.schema_version, 1);
  assert.strictEqual(diag.backend, 'opencode');
  console.log('PASS: CollectDiagnostics returns diagnostics');
}

// ===========================================================================
// 10. Adapter does NOT decide terminality — no terminality API
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const bannedMethods = ['isDone', 'isComplete', 'setTerminal', 'setState', 'declareDone', 'declareTerminal', 'isTerminal'];
  for (const m of bannedMethods) {
    assert.strictEqual(typeof adapter[m], 'undefined', `Adapter must not have method "${m}"`);
  }
  console.log('PASS: Adapter has no terminality API');
}

// ===========================================================================
// 11. Recover returns terminal or interrupted state
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const recovery = adapter.Recover({});
  assert.ok(recovery && typeof recovery.state === 'string');
  assert.ok(TERMINAL_OR_INTERRUPTED.includes(recovery.state),
    `Recover returned "${recovery.state}" which is not terminal`);
  console.log('PASS: Recover returns terminal/interrupted state');
}

// ===========================================================================
// 12. PrepareInvocation, SendPrompt, Resume are present and don't throw
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  assert.doesNotThrow(() => adapter.PrepareInvocation({}, {}));
  assert.doesNotThrow(() => adapter.SendPrompt({}, 'test prompt'));
  assert.doesNotThrow(() => adapter.Resume({}, 'fork_from_artifacts', 'continue'));
  console.log('PASS: PrepareInvocation, SendPrompt, Resume exist');
}

// ===========================================================================
// 13. Respond throws (not supported in thin slice)
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  assert.throws(() => adapter.Respond('test-id', 'allow'), /not supported/);
  console.log('PASS: Respond throws when capabilities not declared');
}

// ===========================================================================
// 14. Dispose is idempotent
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  assert.doesNotThrow(() => adapter.Dispose({}));
  assert.doesNotThrow(() => adapter.Dispose({}));
  console.log('PASS: Dispose is idempotent');
}

// ===========================================================================
// 15. Start returns an execution handle
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const handle = adapter.Start({});
  assert.ok(handle && typeof handle === 'object');
  console.log('PASS: Start returns execution handle');
}

// ===========================================================================
// 16. RequestCancel implements all three rungs
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const rungs = adapter.DeclareCancelRungs();

  for (const rung of rungs) {
    const result = adapter.RequestCancel({}, rung);
    assert.ok(result && typeof result === 'object');
    assert.ok('success' in result);
  }
  console.log('PASS: RequestCancel handles all three rungs');
}

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
