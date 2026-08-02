// @suite full
// @serial  exercises reducer backstop and reconciliation
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { JobStore } = require('../../core/job-store');
const { cancelJob } = require('../../core/cancel');
const { FakeAdapter } = require('../../adapters/fake/adapter');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-rb-test-'));
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function createJob(store, jobId, overrides) {
  store.createJob({
    jobId,
    repoKey: 'test',
    repoRoot: '/tmp/test',
    backend: 'fake',
    backendVersion: '1.0.0',
    adapterVersion: '1.0.0',
    mode: 'run',
    access: 'read-only',
    ...overrides,
  });
}

function createAttempt(store, jobId) {
  store.createAttemptDir({ repoKey: 'test', jobId, attemptNum: 1 });
  store.journalTransition(jobId, 'test', {
    kind: 'attempt_created',
    attempt: 1,
    from: null,
    to: 'created',
    detail: { attempt_id: 'attempt-1', execution_token: 'tok-test' },
  });
}

async function main() {

// ===========================================================================
// 1. Cancelled entry is not overwritten by a later done entry
//    Regression for: live worker appending process_exited → done
//    after cancel already wrote cancelled. The projection must show
//    cancelled, not done.
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = new JobStore({ stateRoot: dir });
    createJob(store, 'rb-test-1');
    createAttempt(store, 'rb-test-1');
    const jobDir = store.getJobDir('test', 'rb-test-1');

    let processAlive = true;
    const adapter = new FakeAdapter({
      declaredRungs: ['hard_kill'],
      facts: [],
      behaviors: {
        onCancel: (rung) => {
          if (rung === 'hard_kill') processAlive = false;
        },
      },
    });

    await cancelJob({
      store, adapter, jobDir, repoKey: 'test', jobId: 'rb-test-1',
      attempt: {}, attemptNum: 1,
      containment: null, executionToken: 'tok-test', pid: 10001,
      isProcessAliveFn: () => processAlive,
      rungWaitMs: 10, hardKillWaitMs: 10,
    });

    // Simulate worker appending process_exited → done after cancel
    store.journalTransition('rb-test-1', 'test', {
      kind: 'attempt_state_changed',
      attempt: 1,
      from: 'running',
      to: 'done',
      detail: { finished_at: new Date().toISOString(), phase: 'terminal' },
    });

    const status = store.readStatus({ repoKey: 'test', jobId: 'rb-test-1' });
    // readStatus reads the cached status.json, which was last written
    // by the second journalTransition. So it would show 'done'.
    // But regenerateStatus should show 'cancelled'.
    const regenerated = store.regenerateStatus({ repoKey: 'test', jobId: 'rb-test-1' });
    assert.strictEqual(regenerated.state, 'cancelled',
      `Regenerated status must be cancelled, got ${regenerated.state}`);
    assert.ok(regenerated.cancel_requested_at,
      'cancel_requested_at must be preserved');

    console.log('PASS: Cancelled entry not overwritten by later done');
  } finally {
    clean(dir);
  }
}

// ===========================================================================
// 2. Timed_out entry is not overwritten by a later done entry
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = new JobStore({ stateRoot: dir });
    createJob(store, 'rb-test-2');
    createAttempt(store, 'rb-test-2');

    // Journal timed_out (hard timeout triggered)
    store.journalTransition('rb-test-2', 'test', {
      kind: 'attempt_state_changed',
      attempt: 1,
      from: 'running',
      to: 'timed_out',
      detail: { finished_at: new Date().toISOString(), phase: 'terminal', failure_reason: 'hard_timeout' },
    });

    // Simulate worker appending done after hard timeout
    store.journalTransition('rb-test-2', 'test', {
      kind: 'attempt_state_changed',
      attempt: 1,
      from: 'timed_out',
      to: 'done',
      detail: { finished_at: new Date().toISOString(), phase: 'terminal' },
    });

    const regenerated = store.regenerateStatus({ repoKey: 'test', jobId: 'rb-test-2' });
    assert.strictEqual(regenerated.state, 'timed_out',
      `Regenerated status must be timed_out, got ${regenerated.state}`);

    console.log('PASS: Timed_out entry not overwritten by later done');
  } finally {
    clean(dir);
  }
}

// ===========================================================================
// 3. Normal done → failed sequence is still allowed
//    (not blocked by the cancel/timeout guard)
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = new JobStore({ stateRoot: dir });
    createJob(store, 'rb-test-3');
    createAttempt(store, 'rb-test-3');

    store.journalTransition('rb-test-3', 'test', {
      kind: 'attempt_state_changed',
      attempt: 1,
      from: 'running',
      to: 'done',
      detail: { finished_at: new Date().toISOString(), phase: 'terminal' },
    });

    const regenerated = store.regenerateStatus({ repoKey: 'test', jobId: 'rb-test-3' });
    assert.strictEqual(regenerated.state, 'done',
      `Normal done state must be preserved, got ${regenerated.state}`);

    console.log('PASS: Normal done state preserved');
  } finally {
    clean(dir);
  }
}

// ===========================================================================
// 3b. A late non-terminal publication cannot resurrect a terminal job.
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = new JobStore({ stateRoot: dir });
    createJob(store, 'rb-test-3b');
    createAttempt(store, 'rb-test-3b');
    store.journalTransition('rb-test-3b', 'test', {
      kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'cancelled',
      detail: { finished_at: new Date().toISOString(), phase: 'terminal' },
    });
    store.journalTransition('rb-test-3b', 'test', {
      kind: 'attempt_state_changed', attempt: 1, from: 'cancelled', to: 'running',
      detail: { started_at: new Date().toISOString(), phase: 'agent_running' },
    });
    assert.strictEqual(store.regenerateStatus({ repoKey: 'test', jobId: 'rb-test-3b' }).state, 'cancelled');
    console.log('PASS: terminal state is not resurrected by a late running publication');
  } finally {
    clean(dir);
  }
}

// ===========================================================================
// 4. Reconcile non-terminal job with dead worker
//    A worker died leaving the journal in running with no process_exited.
//    After reconciliation the job must be interrupted.
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = new JobStore({ stateRoot: dir });
    createJob(store, 'rb-test-4');
    createAttempt(store, 'rb-test-4');

    store.journalTransition('rb-test-4', 'test', {
      kind: 'attempt_state_changed',
      attempt: 1,
      from: 'created',
      to: 'running',
      detail: {
        started_at: new Date().toISOString(),
        phase: 'agent_running',
        worker_pid: 99999,
      },
    });

    const statusBefore = store.readStatus({ repoKey: 'test', jobId: 'rb-test-4' });
    assert.strictEqual(statusBefore.state, 'running',
      'State must be running before reconciliation');

    const reconciled = store.reconcileStatus({ repoKey: 'test', jobId: 'rb-test-4' });
    assert.strictEqual(reconciled.state, 'interrupted',
      `Reconciled state must be interrupted (worker pid 99999 is not alive), got ${reconciled.state}`);

    console.log('PASS: Reconcile non-terminal job with dead worker');
  } finally {
    clean(dir);
  }
}

// ===========================================================================
// 5. Unconfirmed cancel does not set state to cancelled
//    Regression: cancel_requested_at annotation alone (no confirmed kill)
//    must not produce cancelled state.
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = new JobStore({ stateRoot: dir });
    createJob(store, 'rb-test-5');
    createAttempt(store, 'rb-test-5');
    const jobDir = store.getJobDir('test', 'rb-test-5');

    const adapter = new FakeAdapter({
      declaredRungs: ['hard_kill'],
      facts: [],
    });

    const result = await cancelJob({
      store, adapter, jobDir, repoKey: 'test', jobId: 'rb-test-5',
      attempt: {}, attemptNum: 1,
      containment: null, executionToken: 'tok-test', pid: 10005,
      isProcessAliveFn: () => true, // process stays alive
      rungWaitMs: 10, hardKillWaitMs: 10,
    });

    assert.strictEqual(result.exitCode, 21, 'Unconfirmed cancel must exit 21');

    const status = store.readStatus({ repoKey: 'test', jobId: 'rb-test-5' });
    assert.notStrictEqual(status.state, 'cancelled',
      'Unconfirmed cancel must not produce cancelled state');

    const regenerated = store.regenerateStatus({ repoKey: 'test', jobId: 'rb-test-5' });
    assert.notStrictEqual(regenerated.state, 'cancelled',
      'Regenerate after unconfirmed cancel must not show cancelled');

    console.log('PASS: Unconfirmed cancel does not set cancelled');
  } finally {
    clean(dir);
  }
}

// ===========================================================================
// 6. cancel_requested_at is preserved after reconciliation
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = new JobStore({ stateRoot: dir });
    createJob(store, 'rb-test-6');
    createAttempt(store, 'rb-test-6');

    store.journalTransition('rb-test-6', 'test', {
      kind: 'attempt_state_changed',
      attempt: 1,
      from: 'created',
      to: 'running',
      detail: {
        started_at: new Date().toISOString(),
        phase: 'agent_running',
        worker_pid: 99996,
        cancel_requested_at: new Date().toISOString(),
      },
    });

    const reconciled = store.reconcileStatus({ repoKey: 'test', jobId: 'rb-test-6' });
    assert.ok(reconciled.cancel_requested_at,
      'cancel_requested_at must be preserved after reconciliation');

    console.log('PASS: cancel_requested_at preserved after reconciliation');
  } finally {
    clean(dir);
  }
}

// ===========================================================================
// 7. Hard timeout deadline check catches expired non-terminal jobs
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = new JobStore({ stateRoot: dir });
    createJob(store, 'rb-test-7', { hardTimeoutSec: 1 });
    createAttempt(store, 'rb-test-7');

    const startedAt = new Date(Date.now() - 3000).toISOString();
    store.journalTransition('rb-test-7', 'test', {
      kind: 'attempt_state_changed',
      attempt: 1,
      from: 'created',
      to: 'running',
      detail: {
        started_at: startedAt,
        phase: 'agent_running',
      },
    });

    const regenerated = store.regenerateStatus({ repoKey: 'test', jobId: 'rb-test-7' });
    assert.strictEqual(regenerated.state, 'timed_out',
      `Expired hard timeout must produce timed_out, got ${regenerated.state}`);

    console.log('PASS: Hard timeout deadline catch');
  } finally {
    clean(dir);
  }
}

console.log('\nAll reducer backstop tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
