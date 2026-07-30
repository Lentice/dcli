const assert = require('node:assert');
const path = require('path');
const os = require('os');

const { JobStore } = require('../../core/job-store');
const { FakeAdapter } = require('../../adapters/fake/adapter');
const { executeRun } = require('../../core/commands/run');
const { executeResume } = require('../../core/commands/resume');
const { tryDisposeAdapter } = require('../../core/commands/index');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-dispose-test-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return fn(dir).then(cleanup, (err) => { cleanup(); throw err; });
}

const fs = require('fs');

async function main() {

// ===========================================================================
// 1. tryDisposeAdapter returns disposed:true for fake adapter
// ===========================================================================
{
  const adapter = new FakeAdapter({
    facts: [{ type: 'started', backend_pid: 1 }, { type: 'process_exited', code: 0 }],
    exitCode: 0,
  });
  const result = tryDisposeAdapter(adapter, {});
  assert.strictEqual(result.disposed, true, 'tryDisposeAdapter must succeed for fake adapter');
  assert.strictEqual(adapter._disposed, true, 'fake adapter must be marked disposed');
  // Second call is idempotent
  const result2 = tryDisposeAdapter(adapter, {});
  assert.strictEqual(result2.disposed, true, 'second tryDisposeAdapter call must still succeed');
  assert.strictEqual(adapter._disposed, true, 'adapter must still be disposed after second call');
  console.log('PASS: dispose test 1 — tryDisposeAdapter works');
}

// ===========================================================================
// 2. executeRun calls Dispose on normal success
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_1' },
      { type: 'assistant_text', message_id: 'm1', text: 'hello' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const output = await executeRun({
    store, adapter,
    repoKey: 'test-repo',
    prompt: 'test prompt',
    hardTimeoutSec: 60,
  });

  assert.strictEqual(output.text, 'hello', 'run must return result text');
  assert.strictEqual(adapter._disposed, true, 'adapter must be disposed after successful run');
  console.log('PASS: dispose test 2 — run disposes adapter on success');
});

// ===========================================================================
// 3. executeRun calls Dispose on adapter failure
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1 },
      { type: 'process_exited', code: 1 },
    ],
    exitCode: 1,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const output = await executeRun({
    store, adapter,
    repoKey: 'test-repo',
    prompt: 'test prompt',
    hardTimeoutSec: 60,
  });

  assert.ok(adapter._disposed, 'adapter must be disposed after failed run');
  console.log('PASS: dispose test 3 — run disposes adapter on failure');
});

// ===========================================================================
// 4. executeRun disposes adapter on hard timeout
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
    behaviors: { hangAfter: 500 },
  });

  const output = await executeRun({
    store, adapter,
    repoKey: 'test-repo',
    prompt: 'test prompt',
    hardTimeoutSec: 5,
  });

  assert.ok(adapter._disposed, 'adapter must be disposed after run with hang');
  console.log('PASS: dispose test 4 — run disposes adapter on fallback path');
});

// ===========================================================================
// 5. executeResume calls Dispose on success
// ===========================================================================
await withTempDir(async (dir) => {
  // First create a parent job
  const store = new JobStore({ stateRoot: dir });
  const parentAdapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_parent' },
      { type: 'assistant_text', message_id: 'm1', text: 'parent result' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true, resume: true } },
  });

  await executeRun({
    store, adapter: parentAdapter,
    repoKey: 'test-repo',
    prompt: 'parent',
    hardTimeoutSec: 60,
  });

  const parentJobId = (await fs.promises.readdir(path.join(dir, 'jobs', 'test-repo')))[0];

  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 2, backend_session_id: 'ses_child' },
      { type: 'assistant_text', message_id: 'm2', text: 'hello from resume' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true, resume: true } },
  });

  const output = await executeResume({
    store, adapter,
    repoKey: 'test-repo',
    prompt: 'resume prompt',
    kind: 'retry_attempt',
    parentJobId,
    hardTimeoutSec: 60,
  });

  assert.strictEqual(output.text, 'hello from resume', 'resume must return result text');
  assert.strictEqual(adapter._disposed, true, 'adapter must be disposed after successful resume');
  console.log('PASS: dispose test 5 — resume disposes adapter on success');
});

// ===========================================================================
// 6. Dispose is only called once even with multiple terminal paths triggered
// ===========================================================================
await withTempDir(async (dir) => {
  let disposeCount = 0;
  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_1' },
      { type: 'assistant_text', message_id: 'm1', text: 'hello' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  // Wrap Dispose to count calls
  const originalDispose = adapter.Dispose.bind(adapter);
  adapter.Dispose = function(attempt) {
    disposeCount++;
    return originalDispose(attempt);
  };

  const output = await executeRun({
    store, adapter,
    repoKey: 'test-repo',
    prompt: 'test prompt',
    hardTimeoutSec: 60,
  });

  assert.strictEqual(disposeCount, 1, 'Dispose must be called exactly once');
  assert.strictEqual(adapter._disposed, true, 'adapter must be disposed');
  console.log('PASS: dispose test 6 — Dispose called exactly once');
});

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
