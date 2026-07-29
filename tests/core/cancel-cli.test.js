const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { JobStore } = require('../../core/job-store');
const { FakeAdapter } = require('../../adapters/fake/adapter');
const { executeCancel } = require('../../core/commands/cancel');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-cancel-cli-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return fn(dir).then(cleanup, (err) => { cleanup(); throw err; });
}

async function main() {

// =============================================================================
// 1. cancel requires a job ID — missing exits 2
// =============================================================================
{
  try {
    await executeCancel({ store: null, repoKey: 'test', jobId: null });
    assert.fail('Should have thrown for missing job ID');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2);
    assert.ok(err.message.includes('job ID') || err.message.includes('jobId'));
  }
  console.log('PASS: cancel rejects missing job ID');
}

// =============================================================================
// 2. cancel on non-existent job exits 3
// =============================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [], exitCode: 0, declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { cancel: true } },
  });

  try {
    await executeCancel({ store, adapter, repoKey: 'test', jobId: 'nonexistent' });
    assert.fail('Should have thrown for non-existent job');
  } catch (err) {
    assert.strictEqual(err.exitCode, 3);
  }
  console.log('PASS: cancel rejects non-existent job');
});

// =============================================================================
// 3. cancel on already-terminal job is a no-op (exit 0)
// =============================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test';
  const jobId = 'already-done';

  store.createJob({
    jobId, repoKey, repoRoot: '/tmp/test',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
  });
  store.createAttemptDir({ repoKey, jobId, attemptNum: 1 });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created', attempt: 1, from: null, to: 'created',
    detail: { attempt_id: 'a1', execution_token: 'tok1' },
  });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'done',
    detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal' },
  });

  const adapter = new FakeAdapter({
    facts: [], exitCode: 0, declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { cancel: true } },
  });

  const result = await executeCancel({ store, adapter, repoKey, jobId });
  assert.strictEqual(result.exitCode, 0, 'cancel on terminal job must exit 0');
  assert.strictEqual(result.state, 'done', 'state must remain done');

  const status = store.readStatus({ repoKey, jobId });
  assert.strictEqual(status.state, 'done', 'status must still be done');

  console.log('PASS: cancel on terminal job is no-op');
});

// =============================================================================
// 4. cancel with --json produces proper envelope
// =============================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test';
  const jobId = 'json-cancel';

  store.createJob({
    jobId, repoKey, repoRoot: '/tmp/test',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
  });
  store.createAttemptDir({ repoKey, jobId, attemptNum: 1 });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created', attempt: 1, from: null, to: 'created',
    detail: { attempt_id: 'a1', execution_token: 'tok1' },
  });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'done',
    detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal' },
  });

  const adapter = new FakeAdapter({
    facts: [], exitCode: 0, declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { cancel: true } },
  });

  const result = await executeCancel({ store, adapter, repoKey, jobId, json: true });
  assert.ok(result.envelope, 'cancel must return envelope for --json');
  assert.strictEqual(result.envelope.schema_version, 1);
  assert.strictEqual(result.envelope.job_id, jobId);
  assert.strictEqual(result.envelope.state, 'done');

  console.log('PASS: cancel --json produces proper envelope');
});

console.log('\nAll cancel CLI tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
