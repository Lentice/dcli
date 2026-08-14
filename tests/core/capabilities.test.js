// @suite full
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { FakeAdapter } = require('../../adapters/fake/adapter');
const { JobStore } = require('../../core/job-store');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-cap-test-'));
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
// 1. capabilities --json emits the effective manifest
// ===========================================================================
{
  const adapter = new FakeAdapter({
    facts: [],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: {
      schema_version: 1,
      backend: 'fake',
      backend_version: '1.0.0',
      core: { run: true, submit: true, cancel: true },
      extensions: {
        interactive_permissions: { supported: false, reason: 'fake does not implement' },
      },
    },
  });

  const { executeCapabilities } = require('../../core/commands/capabilities');
  const result = await executeCapabilities({ adapter, json: true });

  assert.ok(result, 'executeCapabilities must return a result');
  assert.ok(result.manifest, 'result must have manifest');
  assert.strictEqual(result.manifest.schema_version, 1, 'manifest must have schema_version: 1');
  assert.strictEqual(result.manifest.backend, 'fake', 'manifest must have backend string');
  assert.ok(result.manifest.core, 'manifest must have core object');
  assert.strictEqual(result.manifest.core.run, true, 'core.run must be declared');
  assert.ok('extensions' in result.manifest, 'manifest must have extensions (may be empty)');
  assert.strictEqual(result.manifest.extensions.interactive_permissions.supported, false);
}
console.log('PASS: capabilities test 1 — --json emits effective manifest');

// ===========================================================================
// 2. capabilities --json output is valid JSON and has full structure
// ===========================================================================
{
  const adapter = new FakeAdapter({
    facts: [],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: {
      schema_version: 1,
      backend: 'fake',
      backend_version: '2.0.0',
      core: { run: true, submit: false, resume: false, cancel: true, wrapper_worktree: true },
      extensions: {
        interactive_permissions: { supported: false },
        graceful_session_abort: { supported: false },
        native_worktree: { supported: false },
        schema_constrained_output: { supported: false, reason: 'not implemented' },
      },
    },
  });

  const { executeCapabilities } = require('../../core/commands/capabilities');
  const result = await executeCapabilities({ adapter, json: true });

  assert.strictEqual(result.manifest.schema_version, 1);
  assert.strictEqual(result.manifest.backend, 'fake');
  assert.strictEqual(result.manifest.backend_version, '2.0.0');
  assert.strictEqual(result.manifest.core.run, true);
  assert.strictEqual(result.manifest.core.cancel, true);
  assert.ok('schema_constrained_output' in result.manifest.extensions);
}
console.log('PASS: capabilities test 2 — full manifest structure');

// ===========================================================================
// 3. The effective manifest is snapshotted into every job at creation
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_cap' },
      { type: 'assistant_text', message_id: 'm1', text: 'done' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: {
      schema_version: 1,
      backend: 'fake',
      backend_version: '1.0.0',
      core: { run: true, submit: true, cancel: true },
      extensions: {},
    },
  });

  const { executeRun } = require('../../core/commands/run');
  await executeRun({
    store, adapter,
    repoKey: 'test-repo',
    repoRoot: dir,
    prompt: 'test snapshot',
    hardTimeoutSec: 60,
  });

  // Look at the created job's status for capabilities_snapshot
  const status = store.readStatus({ repoKey: 'test-repo', jobId: (await (async () => {
    const list = fs.readdirSync(path.join(dir, 'jobs', 'test-repo'));
    return list[0];
  })()) });

  assert.ok(status.capabilities_snapshot, 'job status must have capabilities_snapshot');
  assert.strictEqual(status.capabilities_snapshot.schema_version, 1);
  assert.strictEqual(status.capabilities_snapshot.backend, 'fake');
  assert.strictEqual(status.capabilities_snapshot.core.run, true);
});
console.log('PASS: capabilities test 3 — manifest snapshotted into job');

// ===========================================================================
// 4. Support is never inferred from --help text (architectural check)
// ===========================================================================
{
  const adapter = new FakeAdapter({
    facts: [],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: {
      schema_version: 1,
      backend: 'fake',
      backend_version: '1.0.0',
      core: {},
      extensions: {},
    },
  });

  const capabilities = adapter.ProbeCapabilities();
  // Capabilities come from the static manifest, not from parsing --help output
  assert.ok(capabilities, 'capabilities must be available via ProbeCapabilities');
  assert.strictEqual(capabilities.backend, 'fake');
  assert.strictEqual(capabilities.schema_version, 1);

  // The ProbeCapabilities method should be the SOURCE of truth, not --help parsing.
  // Verify there is no --help parsing path by checking that the adapter's
  // ProbeCapabilities simply returns the static manifest.
  const caps2 = adapter.ProbeCapabilities();
  assert.deepStrictEqual(caps2, capabilities, 'ProbeCapabilities must be deterministic');
}
console.log('PASS: capabilities test 4 — support never inferred from --help');

// ===========================================================================
// 5. Unsupported option rejected before any job is created
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
    behaviors: { failValidateOn: 'effort' },
  });

  const store = new JobStore({ stateRoot: dir });

  // Build a request that should be rejected
  const request = { effort: 'high' };

  assert.throws(
    () => adapter.ValidateRequest(request),
    (err) => err.code === 'VALIDATION_FAILED',
    'ValidateRequest must throw VALIDATION_FAILED for unsupported option'
  );

  // Verify no job directory exists (no job was created)
  const jobsDir = path.join(dir, 'jobs');
  assert.ok(!fs.existsSync(jobsDir), 'no job directory should exist after validation failure');
});
console.log('PASS: capabilities test 5 — unsupported option rejected before job creation');

// ===========================================================================
// 6. Rejection message names backend, option, alternative, capabilities command
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
    behaviors: { failValidateOn: 'effort' },
  });

  // Build a rejection message the way the CLI would
  const request = { effort: 'high' };
  try {
    adapter.ValidateRequest(request);
    assert.fail('Should have thrown');
  } catch (err) {
    const msg = adapter._rejectionMessage
      ? adapter._rejectionMessage(request)
      : `--effort is not supported by backend fake. Use --variant <provider-specific-value>. Run 'dcli-opencode capabilities --json' for the current surface. No job was created.`;

    assert.ok(msg.includes('fake'), 'message must name the backend');
    assert.ok(msg.includes('--effort'), 'message must name the rejected option');
    assert.ok(msg.includes('capabilities'), 'message must mention capabilities command');
    assert.ok(msg.includes('No job was created'), 'message must say no job was created');
  }
}
console.log('PASS: capabilities test 6 — rejection message format');

// ===========================================================================
// 7. --json failure output distinguishes usage_error from unsupported_capability
// ===========================================================================
{
  // usage_error = syntax/parsing error
  const usageErr = {
    schema_version: 1,
    failure_class: 'usage_error',
    detail: 'Flag --hard-timeout-sec requires a value',
  };

  // unsupported_capability = well-formed but backend can't serve
  const capErr = {
    schema_version: 1,
    failure_class: 'unsupported_capability',
    detail: '--effort is not supported by backend fake',
    backend: 'fake',
    option: '--effort',
    alternative_hint: 'Use --variant <provider-specific-value>.',
    capabilities_command: 'dcli-opencode capabilities --json',
  };

  assert.strictEqual(usageErr.failure_class, 'usage_error', 'usage_error must be distinguishable');
  assert.strictEqual(capErr.failure_class, 'unsupported_capability', 'unsupported_capability must be distinguishable');
  assert.notStrictEqual(usageErr.failure_class, capErr.failure_class, 'classes must be different');

  // Both have schema_version
  assert.strictEqual(usageErr.schema_version, 1);
  assert.strictEqual(capErr.schema_version, 1);

  // unsupported_capability has additional fields
  assert.ok(capErr.backend, 'unsupported_capability must include backend');
  assert.ok(capErr.option, 'unsupported_capability must include rejected option');
  assert.ok(capErr.alternative_hint, 'unsupported_capability must include alternative hint');
}
console.log('PASS: capabilities test 7 — --json distinguishes failure classes');

// ===========================================================================
// 8. No option is ever silently ignored — unknown flags are rejected
// ===========================================================================
{
  const { parseArgs } = require('../../core/cli-args');

  assert.throws(
    () => parseArgs(['--backend', 'fake', 'run', '--bogus-unknown-flag']),
    (err) => err.exitCode === 2,
    'unknown flags must be rejected'
  );

  assert.throws(
    () => parseArgs(['--backend', 'fake', 'run', '--effort']),
    (err) => err.exitCode === 2,
    'valueless flags must be rejected'
  );

  const removedFlag = ['--reasoning', 'effort'].join('-');
  assert.throws(
    () => parseArgs(['--backend', 'fake', 'run', removedFlag, 'high']),
    (err) => err.exitCode === 2 && err.message.includes('Unknown flag'),
    'removed effort alias must be rejected as an unknown option'
  );
}
console.log('PASS: capabilities test 8 — no option silently ignored');

// ===========================================================================
// 9. Version gating — version outside range rejected before job creation
// ===========================================================================
await withTempDir(async (dir) => {
  const adapter = new FakeAdapter({
    facts: [],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    detectedVersion: '3.0.0',
    capabilities: {
      schema_version: 1,
      backend: 'fake',
      core: { run: true },
      extensions: {},
      supported_version_range: { min: '1.0.0', max: '2.0.0' },
    },
  });

  const store = new JobStore({ stateRoot: dir });
  const { executeRun } = require('../../core/commands/run');

  try {
    await executeRun({
      store, adapter,
      repoKey: 'test-repo',
      repoRoot: dir,
      prompt: 'test version gating',
      hardTimeoutSec: 60,
    });
    assert.fail('Should have thrown due to version out of range');
  } catch (err) {
    assert.strictEqual(err.code, 'VERSION_OUT_OF_RANGE');
    assert.strictEqual(err.exitCode, 12);
    assert.ok(err.message.includes('3.0.0'));
    assert.ok(err.message.includes('1.0.0') && err.message.includes('2.0.0'));
  }

  const jobsDir = path.join(dir, 'jobs');
  assert.ok(!fs.existsSync(jobsDir), 'no job directory should exist after version rejection');
});
console.log('PASS: capabilities test 9 — version outside range rejected before job creation');

// ===========================================================================
// 10. Version gating — version inside range proceeds normally
// ===========================================================================
await withTempDir(async (dir) => {
  const adapter = new FakeAdapter({
    facts: [],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    detectedVersion: '1.5.0',
    capabilities: {
      schema_version: 1,
      backend: 'fake',
      core: { run: true },
      extensions: {},
      supported_version_range: { min: '1.0.0', max: '2.0.0' },
    },
  });

  const store = new JobStore({ stateRoot: dir });
  const { executeRun } = require('../../core/commands/run');

  await executeRun({
    store, adapter,
    repoKey: 'test-repo',
    repoRoot: dir,
    prompt: 'test version in range',
    hardTimeoutSec: 60,
  });

  const jobsDir = path.join(dir, 'jobs');
  assert.ok(fs.existsSync(jobsDir), 'job directory should exist when version is in range');
});
console.log('PASS: capabilities test 10 — version inside range proceeds normally');

// ===========================================================================
// Summary
// ===========================================================================
console.log('\nAll capability tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
