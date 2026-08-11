// Ticket 103, criteria B (engine half) and D. A taskkill-tree rung reports
// its survivors back to the engine; the engine must record what the rung
// verified and — when survivors remain — exit 21 with the survivors named
// instead of writing a clean `cancelled`. These are core tests: the survivor
// result is injected via the FakeAdapter (the ticket sanctions injecting the
// enumeration/verification results because a survivor cannot be constructed
// reliably in a core test), so they run on every platform.
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { JobStore } = require('../../core/job-store');
const { FakeAdapter } = require('../../adapters/fake/adapter');
const { cancelJob } = require('../../core/cancel');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-taskkill-cancel-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return fn(dir).then(cleanup, (err) => { cleanup(); throw err; });
}

function createJob(store, repoKey, jobId) {
  store.createJob({
    jobId, repoKey, repoRoot: '/tmp/test-repo', backend: 'fake',
    backendVersion: '1.0.0', adapterVersion: '1.0.0', mode: 'run', access: 'read-only',
  });
  store.createAttemptDir({ repoKey, jobId, attemptNum: 1 });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created', attempt: 1, from: null, to: 'created',
    detail: { attempt_id: 'attempt-1', execution_token: 'tok-test' },
  });
}

const TREE_KILL = (survivors) => ({ kind: 'taskkill-tree', degraded: true, survivors });

async function main() {

  // =========================================================================
  // Criterion B (engine) — a rung that reports survivors exits 21, names the
  // survivors, and is NOT a clean cancelled outcome. The record keeps the
  // containment + survivor set a reader can find.
  // =========================================================================
  await withTempDir(async (dir) => {
    const store = new JobStore({ stateRoot: dir });
    const repoKey = 'repo-a';
    const jobId = 'cancel-survivors';
    createJob(store, repoKey, jobId);
    const jobDir = store.getJobDir(repoKey, jobId);

    const adapter = new FakeAdapter({
      declaredRungs: ['hard_kill'],
      facts: [],
      behaviors: {
        termination: TREE_KILL([{ pid: 4242, imagePath: 'C:\\tools\\stubborn.exe', reason: 'still_running' }]),
      },
    });

    const result = await cancelJob({
      store, adapter, jobDir, repoKey, jobId,
      attempt: {}, attemptNum: 1,
      containment: null, executionToken: 'tok-test', pid: 1001,
      isProcessAliveFn: () => true,
      rungWaitMs: 10, hardKillWaitMs: 10,
    });

    assert.strictEqual(result.exitCode, 21,
      'survivors must force exit 21, not a clean cancel');
    assert.notStrictEqual(result.state, 'cancelled',
      'survivors must NOT report a clean cancelled outcome');
    assert.strictEqual(result.warning, 'termination_unconfirmed');
    assert.strictEqual(result.survivors.length, 1, 'the result must name the survivors');
    assert.strictEqual(result.survivors[0].pid, 4242);
    assert.strictEqual(result.survivors[0].reason, 'still_running');

    const status = store.readStatus({ repoKey, jobId });
    assert.deepStrictEqual(status.containment, { kind: 'taskkill-tree', degraded: true },
      'the job record must carry the taskkill-tree containment record');
    assert.deepStrictEqual(status.containment_survivors, [
      { pid: 4242, image_path: 'C:\\tools\\stubborn.exe', reason: 'still_running' },
    ], 'the job record must carry the survivor set with pid, image path and reason');
    assert.notStrictEqual(status.state, 'cancelled', 'the record must not claim a clean cancellation');

    console.log('PASS: criterion B (engine) — survivor path exits 21 and names the survivors');
  });

  // =========================================================================
  // Criterion D — a taskkill-tree rung that verified an empty survivor set
  // still records containment: { kind: 'taskkill-tree', degraded: true }, and
  // `degraded` is true even though nothing survived.
  // =========================================================================
  await withTempDir(async (dir) => {
    const store = new JobStore({ stateRoot: dir });
    const repoKey = 'repo-b';
    const jobId = 'cancel-clean-tree';
    createJob(store, repoKey, jobId);
    const jobDir = store.getJobDir(repoKey, jobId);

    let processAlive = true;
    const adapter = new FakeAdapter({
      declaredRungs: ['hard_kill'],
      facts: [],
      behaviors: {
        onCancel: () => { processAlive = false; },
        termination: TREE_KILL([]),
      },
    });

    const result = await cancelJob({
      store, adapter, jobDir, repoKey, jobId,
      attempt: {}, attemptNum: 1,
      containment: null, executionToken: 'tok-test', pid: 1002,
      isProcessAliveFn: () => processAlive,
      rungWaitMs: 10, hardKillWaitMs: 10,
    });

    assert.strictEqual(result.exitCode, 0, 'an empty survivor set means the rung succeeded');
    assert.strictEqual(result.state, 'cancelled');

    const status = store.readStatus({ repoKey, jobId });
    assert.deepStrictEqual(status.containment, { kind: 'taskkill-tree', degraded: true },
      'the record must still say degraded: true when nothing survived');
    assert.deepStrictEqual(status.containment_survivors, [],
      'an empty survivor set must still be recorded, so a reader can tell "verified clean within the set" from "no rung ran"');

    console.log('PASS: criterion D — empty survivor set still records degraded taskkill-tree');
  });

  // =========================================================================
  // Criterion B (boundary) — no termination report at all (a rung that only
  // returns success) keeps the pre-ticket behaviour: the engine does not
  // invent survivors, and the record stays unchanged.
  // =========================================================================
  await withTempDir(async (dir) => {
    const store = new JobStore({ stateRoot: dir });
    const repoKey = 'repo-c';
    const jobId = 'cancel-no-termination';
    createJob(store, repoKey, jobId);
    const jobDir = store.getJobDir(repoKey, jobId);

    let processAlive = true;
    const adapter = new FakeAdapter({
      declaredRungs: ['hard_kill'],
      facts: [],
      behaviors: { onCancel: () => { processAlive = false; } },
    });

    const result = await cancelJob({
      store, adapter, jobDir, repoKey, jobId,
      attempt: {}, attemptNum: 1,
      containment: null, executionToken: 'tok-test', pid: 1003,
      isProcessAliveFn: () => processAlive,
      rungWaitMs: 10, hardKillWaitMs: 10,
    });

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.state, 'cancelled');
    const status = store.readStatus({ repoKey, jobId });
    assert.strictEqual(status.containment, null, 'no tree-kill rung ran, so no containment record is invented');
    assert.strictEqual(status.containment_survivors, null, 'no survivors are invented for a rung that reported none');

    console.log('PASS: criterion B (boundary) — no termination report invents nothing');
  });
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
