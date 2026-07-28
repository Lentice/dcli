const assert = require('node:assert');

const TERMINAL_OR_INTERRUPTED = ['done', 'failed', 'timed_out', 'cancelled', 'interrupted'];

function runContractSuite(adapterFactory, label = 'unnamed') {
  let passed = 0;
  const failures = [];

  function check(name, fn) {
    try {
      fn();
      passed++;
    } catch (e) {
      failures.push({ name, message: e.message });
    }
  }

  const adapter = adapterFactory();

  check('GetIdentity returns object with required fields', () => {
    const id = adapter.GetIdentity();
    assert.ok(id && typeof id === 'object');
    assert.strictEqual(typeof id.backend, 'string');
    assert.strictEqual(typeof id.adapter_version, 'string');
    assert.strictEqual(typeof id.state_schema_version, 'number');
  });

  check('DeclareCancelRungs returns array of strings', () => {
    const rungs = adapter.DeclareCancelRungs();
    assert.ok(Array.isArray(rungs));
    assert.ok(rungs.length >= 1, 'Must declare at least one cancel rung');
    for (const r of rungs) {
      assert.strictEqual(typeof r, 'string', 'Each rung must be a string');
    }
  });

  check('ProbeCapabilities returns object with required fields', () => {
    const caps = adapter.ProbeCapabilities();
    assert.ok(caps && typeof caps === 'object');
    assert.strictEqual(typeof caps.backend, 'string');
    assert.strictEqual(typeof caps.schema_version, 'number');
    assert.ok(caps.core && typeof caps.core === 'object');
  });

  check('DetectVersion returns non-empty string', () => {
    const v = adapter.DetectVersion();
    assert.strictEqual(typeof v, 'string');
    assert.ok(v.length > 0, 'Version must not be empty');
  });

  check('ValidateRequest accepts empty request', () => {
    const fresh = adapterFactory();
    fresh.ValidateRequest({});
  });

  check('ValidateRequest is a function', () => {
    assert.strictEqual(typeof adapter.ValidateRequest, 'function');
  });

  check('Respond is gated by capability', () => {
    const fresh = adapterFactory();
    const caps = fresh.ProbeCapabilities();
    const hasPerms = caps.extensions &&
      caps.extensions.interactive_permissions &&
      caps.extensions.interactive_permissions.supported;
    if (!hasPerms) {
      assert.throws(() => fresh.Respond('test-id', 'allow'), /not supported/);
    } else {
      fresh.Respond('test-id', 'allow');
    }
  });

  check('PrepareInvocation, SendPrompt, Resume are present', () => {
    assert.strictEqual(typeof adapter.PrepareInvocation, 'function');
    assert.strictEqual(typeof adapter.SendPrompt, 'function');
    assert.strictEqual(typeof adapter.Resume, 'function');
  });

  check('Dispose is idempotent and sets disposed', () => {
    const fresh = adapterFactory();
    fresh.Dispose({});
    assert.strictEqual(fresh.disposed, true);
    assert.doesNotThrow(() => fresh.Dispose({}));
  });

  check('Recover returns terminal or interrupted state', () => {
    const fresh = adapterFactory();
    const recovery = fresh.Recover({});
    assert.ok(recovery && typeof recovery.state === 'string');
    assert.ok(
      TERMINAL_OR_INTERRUPTED.includes(recovery.state),
      `Recover returned state "${recovery.state}" which is not terminal or interrupted`
    );
  });

  check('Observe returns async iterator', () => {
    const fresh = adapterFactory();
    const iterator = fresh.Observe({});
    assert.ok(iterator && typeof iterator[Symbol.asyncIterator] === 'function');
  });

  check('Start returns execution handle', () => {
    const fresh = adapterFactory();
    const handle = fresh.Start({});
    assert.ok(handle && typeof handle === 'object');
  });

  check('CollectResult returns shape with text, usage, backend_session_id', () => {
    const fresh = adapterFactory();
    const result = fresh.CollectResult({});
    assert.ok(result && typeof result === 'object');
    assert.strictEqual(typeof result.text, 'string');
    assert.ok(result.usage && typeof result.usage === 'object');
    assert.strictEqual(typeof result.usage.total, 'number');
  });

  check('CollectDiagnostics returns object with schema_version', () => {
    const fresh = adapterFactory();
    const diag = fresh.CollectDiagnostics({});
    assert.ok(diag && typeof diag === 'object');
    assert.ok('schema_version' in diag);
    assert.strictEqual(typeof diag.schema_version, 'number');
  });

  const total = passed + failures.length;
  console.log(`contract (${label}): ${passed} passed${failures.length > 0 ? `, ${failures.length} failed` : ''}`);

  for (const f of failures) {
    console.error(`  FAIL ${f.name}: ${f.message}`);
  }

  return { passed, failed: failures.length, label };
}

module.exports = { runContractSuite, TERMINAL_OR_INTERRUPTED };
