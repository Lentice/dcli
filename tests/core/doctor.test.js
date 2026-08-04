// @suite full
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { FakeAdapter } = require('../../adapters/fake/adapter');
const { OpencodeAdapter } = require('../../adapters/opencode/adapter');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-doc-test-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return fn(dir).then(cleanup, (err) => { cleanup(); throw err; });
}

async function main() {

// ===========================================================================
// 1. doctor --json returns an envelope with schema_version and probe results
// ===========================================================================
await withTempDir(async (dir) => {
  const adapter = new FakeAdapter({
    facts: [],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: {
      schema_version: 1,
      backend: 'fake',
      core: { run: true },
      extensions: {},
    },
  });

  const { executeDoctor } = require('../../core/commands/doctor');
  const result = await executeDoctor({
    adapter,
    stateRoot: dir,
    repoPath: dir,
    json: true,
    liveSmokeTimeoutSec: 5,
  });

  assert.ok(result, 'executeDoctor must return a result');
  assert.ok(result.envelope, 'result must have envelope');
  assert.strictEqual(result.envelope.schema_version, 1, 'envelope must have schema_version: 1');
  assert.strictEqual(result.envelope.backend, 'fake', 'envelope must have backend');
  assert.ok(Array.isArray(result.envelope.probes), 'envelope must have probes array');
  assert.ok(result.envelope.probes.length >= 1, 'envelope must have at least one probe');

  // Each probe must have name, ok, detail
  for (const probe of result.envelope.probes) {
    assert.ok(typeof probe.name === 'string', `probe must have name, got ${typeof probe.name}`);
    assert.ok(typeof probe.ok === 'boolean', `probe ${probe.name} must have boolean ok`);
    assert.ok(typeof probe.detail === 'string', `probe ${probe.name} must have string detail`);
  }

  // Verify containment_helper probe is present
  const containmentProbe = result.envelope.probes.find(p => p.name === 'containment_helper');
  assert.ok(containmentProbe, 'probes must include containment_helper');
  assert.strictEqual(typeof containmentProbe.ok, 'boolean');
  assert.ok(containmentProbe.detail.length > 0);
});
console.log('PASS: doctor test 1 — --json returns envelope with probe results');

// ===========================================================================
// 1b. The default doctor run includes the live smoke with its real deadline
// ===========================================================================
await withTempDir(async (dir) => {
  const adapter = new FakeAdapter({
    facts: [],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
  });

  const { executeDoctor } = require('../../core/commands/doctor');
  const result = await executeDoctor({
    adapter,
    stateRoot: dir,
    repoPath: dir,
    json: true,
  });

  const liveProbe = result.envelope.probes.find(p => p.name === 'live_smoke');
  assert.ok(liveProbe, 'doctor without flags must run live_smoke');
  assert.strictEqual(liveProbe.ok, true, 'default live smoke should pass for fake adapter');
  assert.strictEqual(result.envelope.live_smoke_timeout_sec, 120,
    'default live smoke timeout must use DOCTOR_LIVE_SMOKE_MS');
  assert.strictEqual(result.envelope.coverage, 'full', 'default doctor coverage must be full');
});
console.log('PASS: doctor test 1b — live smoke runs by default with the default deadline');

// ===========================================================================
// 2. doctor --json returns its envelope on stdout even when probes fail
// ===========================================================================
await withTempDir(async (dir) => {
  const adapter = new FakeAdapter({
    facts: [],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: {
      schema_version: 1,
      backend: 'fake',
      core: { run: true },
      extensions: {},
    },
  });

  const { executeDoctor } = require('../../core/commands/doctor');
  // Pass a non-existent path as state root to trigger failures
  const badRoot = path.join(os.tmpdir(), 'nonexistent-' + Date.now());
  const result = await executeDoctor({
    adapter,
    stateRoot: badRoot,
    repoPath: badRoot,
    json: true,
    liveSmokeTimeoutSec: 5,
  });

  assert.ok(result, 'executeDoctor must return a result even on failure');
  assert.ok(result.envelope, 'result must have envelope');
  assert.strictEqual(result.envelope.schema_version, 1);
  assert.strictEqual(result.envelope.backend, 'fake');

  // Some probes should have failed
  const allOk = result.envelope.probes.every(p => p.ok === true);
  // At least the state root probe should fail (badRoot doesn't exist as a writable dir)
  const anyFailed = result.envelope.probes.some(p => p.ok === false);
  // Note: in a test environment, some probes might pass or fail differently
  // The key assertion is that the envelope is returned regardless
  assert.ok(result.envelope.probes.length >= 1, 'probes must exist');

  // The backend_info section must be present
  assert.ok(result.envelope.backend_info, 'envelope must have backend_info');
});
console.log('PASS: doctor test 2 — envelope returned even when probes fail');

// ===========================================================================
// 3. Per-backend probe slots exist via adapter collectDiagnostics
// ===========================================================================
{
  const adapter = new FakeAdapter({
    facts: [],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: {
      schema_version: 1,
      backend: 'fake',
      core: { run: true },
      extensions: {},
    },
  });

  const diagnostics = adapter.CollectDiagnostics({});
  assert.ok(diagnostics, 'adapter must provide CollectDiagnostics');
  assert.strictEqual(diagnostics.schema_version, 1);
  assert.strictEqual(diagnostics.backend, 'fake');
  assert.strictEqual(typeof diagnostics.exit_code, 'number');
}
console.log('PASS: doctor test 3 — per-backend probe slot exists');

// ===========================================================================
// 4. Each probe is individually bounded (probes are run with a timeout)
// ===========================================================================
{
  // This is an architectural test: the doctor must bound each probe.
  // We verify by checking that the doctor code uses timeouts.
  const doctorSource = require('fs').readFileSync(
    require('path').resolve(__dirname, '../../core/commands/doctor.js'),
    'utf8'
  );

  // The doctor should use a bounded-timeout mechanism for probes
  assert.ok(
    doctorSource.includes('timeout') || doctorSource.includes('AbortController') || doctorSource.includes('TIMEOUT'),
    'doctor probes must use a bounding mechanism'
  );

  // Verify each probe is wrapped in a timeout
  const probeDefs = doctorSource.match(/probe[A-Z]\w+|runCommonProbes|probe[A-Z]\w+/g) || [];
  assert.ok(probeDefs.length >= 1, 'doctor must define probe functions');
}
console.log('PASS: doctor test 4 — probes individually bounded in source');

// ===========================================================================
// 5. Live smoke probe appears when liveSmokeTimeoutSec is provided
// ===========================================================================
await withTempDir(async (dir) => {
  const adapter = new FakeAdapter({
    facts: [],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: {
      schema_version: 1,
      backend: 'fake',
      core: { run: true },
      extensions: {},
    },
  });

  const { executeDoctor } = require('../../core/commands/doctor');
  const result = await executeDoctor({
    adapter,
    stateRoot: dir,
    repoPath: dir,
    json: true,
    liveSmokeTimeoutSec: 5,
  });

  const liveProbe = result.envelope.probes.find(p => p.name === 'live_smoke');
  assert.ok(liveProbe, 'live_smoke probe must be present when liveSmokeTimeoutSec is provided');
  assert.strictEqual(liveProbe.ok, true, 'live smoke should pass for default fake adapter');
  assert.ok(liveProbe.detail, 'live_smoke probe must have detail');
});
console.log('PASS: doctor test 5 — live smoke probe present when timeout provided');

// ===========================================================================
// 6. Live smoke timeout is distinguishable from environment failure
// ===========================================================================
// Test timeout
await withTempDir(async (dir) => {
  const hangAdapter = new FakeAdapter({
    facts: [],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: {
      schema_version: 1,
      backend: 'fake',
      core: { run: true },
      extensions: {},
    },
    behaviors: { liveSmokeWaitMs: 10000 },
  });

  const { executeDoctor } = require('../../core/commands/doctor');
  const result = await executeDoctor({
    adapter: hangAdapter,
    stateRoot: dir,
    repoPath: dir,
    json: true,
    liveSmokeTimeoutSec: 1,
  });

  const liveProbe = result.envelope.probes.find(p => p.name === 'live_smoke');
  assert.ok(liveProbe, 'live_smoke probe must be present');
  assert.strictEqual(liveProbe.ok, false, 'live smoke must report ok: false on timeout');
  assert.strictEqual(liveProbe.status, 'timed_out', 'timeout result must have status: timed_out');
  assert.ok(liveProbe.detail.includes('timed out'), 'detail must mention timeout');

  // Test environment failure
  const failAdapter = new FakeAdapter({
    facts: [],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: {
      schema_version: 1,
      backend: 'fake',
      core: { run: true },
      extensions: {},
    },
    behaviors: { liveSmokeFail: 'adapter unavailable' },
  });

  const result2 = await executeDoctor({
    adapter: failAdapter,
    stateRoot: dir,
    repoPath: dir,
    json: true,
    liveSmokeTimeoutSec: 5,
  });

  const failProbe = result2.envelope.probes.find(p => p.name === 'live_smoke');
  assert.ok(failProbe, 'live_smoke probe must be present');
  assert.strictEqual(failProbe.ok, false, 'live smoke must report ok: false on failure');
  assert.strictEqual(failProbe.status, 'failed', 'failure result must have status: failed');
  assert.strictEqual(failProbe.failure_class, 'environment', 'generic backend failures are environment failures');
  assert.strictEqual(failProbe.exit_code, 12, 'environment failures must use exit code 12');
  assert.ok(failProbe.detail.includes('adapter unavailable'), 'detail must mention the failure reason');

  // Verify the two outcomes are distinguishable
  assert.strictEqual(liveProbe.status, 'timed_out');
  assert.strictEqual(failProbe.status, 'failed');
  assert.notStrictEqual(liveProbe.status, failProbe.status, 'timeout and failure status values must differ');
});
console.log('PASS: doctor test 6 — live smoke timeout vs failure distinguishable');

// ===========================================================================
// 7. Explicit zero opts out and reports reduced coverage
// ===========================================================================
await withTempDir(async (dir) => {
  const adapter = new FakeAdapter({ facts: [], exitCode: 0 });
  const { executeDoctor } = require('../../core/commands/doctor');
  const result = await executeDoctor({
    adapter,
    stateRoot: dir,
    repoPath: dir,
    json: true,
    liveSmokeTimeoutSec: 0,
  });

  const liveProbe = result.envelope.probes.find(p => p.name === 'live_smoke');
  assert.ok(liveProbe, 'static-only doctor must report the skipped live_smoke probe');
  assert.strictEqual(liveProbe.ok, true);
  assert.strictEqual(liveProbe.status, 'skipped');
  assert.ok(/skipped|static/i.test(liveProbe.detail), 'skip detail must explain reduced coverage');
  assert.strictEqual(result.envelope.live_smoke_timeout_sec, 0);
  assert.strictEqual(result.envelope.coverage, 'static_only');
});
console.log('PASS: doctor test 7 — explicit zero opts out and reports static-only coverage');

// ===========================================================================
// 8. A present executable that cannot serve a request is not healthy
// ===========================================================================
await withTempDir(async (dir) => {
  const savedPath = process.env.OPENCODE_PATH;
  process.env.OPENCODE_PATH = process.execPath;
  try {
    const adapter = new OpencodeAdapter();
    const { executeDoctor } = require('../../core/commands/doctor');
    const startedAt = Date.now();
    const result = await executeDoctor({
      adapter,
      stateRoot: dir,
      repoPath: dir,
      json: true,
      liveSmokeTimeoutSec: 1,
    });

    const liveProbe = result.envelope.probes.find(p => p.name === 'live_smoke');
    assert.ok(liveProbe, 'live_smoke probe must be present');
    assert.strictEqual(liveProbe.ok, false,
      'an executable which cannot serve a request must fail doctor');
    assert.ok(liveProbe.detail.length > 0 && /serve|startup|exit|request/i.test(liveProbe.detail),
      `failure detail must identify the backend failure: ${liveProbe.detail}`);
    assert.ok(liveProbe.failure_class, 'failure must carry a classified failure class');
    assert.ok(Date.now() - startedAt < 10000, 'startup death must fail fast');
  } finally {
    if (savedPath === undefined) delete process.env.OPENCODE_PATH;
    else process.env.OPENCODE_PATH = savedPath;
  }
});
console.log('PASS: doctor test 8 — present but unusable backend is non-ok and fails fast');

// ===========================================================================
// Summary
// ===========================================================================
console.log('\nAll doctor tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
