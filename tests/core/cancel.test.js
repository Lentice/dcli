const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { JobStore } = require('../../core/job-store');
const { FakeAdapter } = require('../../adapters/fake/adapter');
const { cancelJob } = require('../../core/cancel');

const TERMINAL = ['done', 'failed', 'timed_out', 'cancelled', 'interrupted'];

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dcli-cancel-test-'));
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
    jobId,
    repoKey,
    repoRoot: '/tmp/test-repo',
    backend: 'fake',
    backendVersion: '1.0.0',
    adapterVersion: '1.0.0',
    mode: 'run',
    access: 'read-only',
  });

  store.createAttemptDir({ repoKey, jobId, attemptNum: 1 });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created',
    attempt: 1,
    from: null,
    to: 'created',
    detail: {
      attempt_id: 'attempt-1',
      execution_token: 'tok-test',
    },
  });
}

async function main() {

// ===========================================================================
// 1. Single rung (hard_kill) cancels correctly (Codex/Claude pattern)
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const jobId = 'cancel-test-1';
  createJob(store, repoKey, jobId);
  const jobDir = store.getJobDir(repoKey, jobId);

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

  const result = await cancelJob({
    store, adapter, jobDir, repoKey, jobId,
    attempt: {}, attemptNum: 1,
    containment: null, executionToken: 'tok-test', pid: 1001,
    isProcessAliveFn: () => processAlive,
    rungWaitMs: 10, hardKillWaitMs: 10,
  });

  assert.strictEqual(result.state, 'cancelled', 'Single rung must produce cancelled state');
  assert.strictEqual(result.cancelRungReached, 'hard_kill', 'Single rung must record hard_kill');
  assert.strictEqual(result.exitCode, 0, 'Single rung must exit 0');

  const status = store.readStatus({ repoKey, jobId });
  assert.strictEqual(status.state, 'cancelled', 'Status must reflect cancelled state');
  assert.ok(status.cancel_requested_at, 'Status must have cancel_requested_at');
  assert.ok(status.backend_state, 'Status must have backend_state');
  assert.strictEqual(status.backend_state.cancel_rung_reached, 'hard_kill', 'backend_state must record rung');

  const cancelRequestPath = path.join(jobDir, 'cancel.request');
  assert.ok(fs.existsSync(cancelRequestPath), 'cancel.request must exist');

  assert.ok(!processAlive, 'Process must be dead after cancel');
  console.log('PASS: cancel test 1 — single rung (hard_kill)');
});

// ===========================================================================
// 2. Three rungs where first two fail, third succeeds
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const jobId = 'cancel-test-2';
  createJob(store, repoKey, jobId);
  const jobDir = store.getJobDir(repoKey, jobId);

  let processAlive = true;
  const adapter = new FakeAdapter({
    declaredRungs: ['graceful_stop', 'flush', 'hard_kill'],
    rungFailures: { graceful_stop: true, flush: true },
    facts: [],
    behaviors: {
      onCancel: (rung) => {
        if (rung === 'hard_kill') processAlive = false;
      },
    },
  });

  const result = await cancelJob({
    store, adapter, jobDir, repoKey, jobId,
    attempt: {}, attemptNum: 1,
    containment: null, executionToken: 'tok-test', pid: 1002,
    isProcessAliveFn: () => processAlive,
    rungWaitMs: 10, hardKillWaitMs: 10,
  });

  assert.strictEqual(result.state, 'cancelled', 'Three-rung escalation must produce cancelled');
  assert.strictEqual(result.cancelRungReached, 'hard_kill', 'Third rung must be recorded');
  assert.strictEqual(result.exitCode, 0, 'Three-rung escalation must exit 0');

  const status = store.readStatus({ repoKey, jobId });
  assert.strictEqual(status.backend_state.cancel_rung_reached, 'hard_kill', 'backend_state must record hard_kill');
  console.log('PASS: cancel test 2 — three rungs, first two fail');
});

// ===========================================================================
// 3. False success — rung reports success but process stays alive → exit 21
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const jobId = 'cancel-test-3';
  createJob(store, repoKey, jobId);
  const jobDir = store.getJobDir(repoKey, jobId);

  const adapter = new FakeAdapter({
    declaredRungs: ['session_abort', 'hard_kill'],
    facts: [],
  });

  const result = await cancelJob({
    store, adapter, jobDir, repoKey, jobId,
    attempt: {}, attemptNum: 1,
    containment: null, executionToken: 'tok-test', pid: 1003,
    isProcessAliveFn: () => true,
    rungWaitMs: 10, hardKillWaitMs: 10,
  });

  assert.strictEqual(result.exitCode, 21, 'False success must exit 21');
  // Every declared rung (including the adapter's own 'hard_kill') failed to kill the
  // process, and containment is null, so nothing escalated. Recording 'hard_kill' here
  // would be indistinguishable from the adapter's hard_kill rung having worked — see
  // tests/core/hard-kill-honesty.test.js.
  assert.strictEqual(result.cancelRungReached, 'containment_unavailable',
    'With no rung effective and no containment, the record must name why nothing was killed');
  assert.strictEqual(result.warning, 'termination_unconfirmed', 'Must warn about unconfirmed termination');

  const status = store.readStatus({ repoKey, jobId });
  assert.notStrictEqual(status.state, 'cancelled', 'Job must NOT be cancelled when process stays alive');
  console.log('PASS: cancel test 3 — false success yields exit 21');
});

// ===========================================================================
// 4. Cancel created job with live worker (predecessor bug regression)
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const jobId = 'cancel-test-4';
  createJob(store, repoKey, jobId);
  const jobDir = store.getJobDir(repoKey, jobId);

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

  const result = await cancelJob({
    store, adapter, jobDir, repoKey, jobId,
    attempt: {}, attemptNum: 1,
    containment: null, executionToken: 'tok-test', pid: 1004,
    isProcessAliveFn: () => processAlive,
    rungWaitMs: 10, hardKillWaitMs: 10,
  });

  assert.strictEqual(result.state, 'cancelled', 'Created job with live worker must cancel');
  assert.strictEqual(result.exitCode, 0, 'Created job with live worker must exit 0');
  assert.ok(!processAlive, 'Worker must be killed');

  const status = store.readStatus({ repoKey, jobId });
  assert.strictEqual(status.state, 'cancelled', 'Status must show cancelled');
  assert.ok(status.cancel_requested_at, 'cancel_requested_at must be set');
  console.log('PASS: cancel test 4 — created job with live worker is killed');
});

// ===========================================================================
// 5. Cancel created job with no worker
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const jobId = 'cancel-test-5';
  createJob(store, repoKey, jobId);
  const jobDir = store.getJobDir(repoKey, jobId);

  const adapter = new FakeAdapter({
    declaredRungs: ['hard_kill'],
    facts: [],
  });

  const result = await cancelJob({
    store, adapter, jobDir, repoKey, jobId,
    attempt: {}, attemptNum: 1,
    containment: null, executionToken: 'tok-test', pid: null,
    isProcessAliveFn: () => false,
    rungWaitMs: 10, hardKillWaitMs: 10,
  });

  assert.strictEqual(result.state, 'cancelled', 'Created job with no worker must cancel');
  assert.strictEqual(result.exitCode, 0, 'Created job with no worker must exit 0');
  assert.ok(result.cancelRungReached, 'Must record a successful run');

  const status = store.readStatus({ repoKey, jobId });
  assert.strictEqual(status.state, 'cancelled', 'Status must show cancelled');
  console.log('PASS: cancel test 5 — created job with no worker');
});

// ===========================================================================
// 6. Cancel already-terminal job — no-op
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const jobId = 'cancel-test-6';
  createJob(store, repoKey, jobId);
  const jobDir = store.getJobDir(repoKey, jobId);

  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed',
    attempt: 1,
    from: 'created',
    to: 'done',
    detail: { finished_at: new Date().toISOString() },
  });

  const adapter = new FakeAdapter({ declaredRungs: ['hard_kill'], facts: [] });

  const result = await cancelJob({
    store, adapter, jobDir, repoKey, jobId,
    attempt: {}, attemptNum: 1,
    containment: null, executionToken: 'tok-test', pid: null,
    isProcessAliveFn: () => false,
    rungWaitMs: 10, hardKillWaitMs: 10,
  });

  assert.strictEqual(result.state, 'done', 'Already-done job must keep its state');
  assert.strictEqual(result.cancelRungReached, null, 'No rung for terminal job');
  assert.strictEqual(result.exitCode, 0, 'Terminal job cancel must exit 0');
  console.log('PASS: cancel test 6 — already-terminal job is no-op');
});

// Test each terminal state
for (const terminalState of TERMINAL) {
  await withTempDir(async (dir) => {
    const store = new JobStore({ stateRoot: dir });
    const repoKey = 'test-repo';
    const jobId = `cancel-test-6b-${terminalState}`;
    createJob(store, repoKey, jobId);
    const jobDir = store.getJobDir(repoKey, jobId);

    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed',
      attempt: 1,
      from: 'created',
      to: terminalState,
      detail: { finished_at: new Date().toISOString() },
    });

    const adapter = new FakeAdapter({ declaredRungs: ['hard_kill'], facts: [] });

    const result = await cancelJob({
      store, adapter, jobDir, repoKey, jobId,
      attempt: {}, attemptNum: 1,
      containment: null, executionToken: null, pid: null,
      isProcessAliveFn: () => false,
      rungWaitMs: 10, hardKillWaitMs: 10,
    });

    assert.strictEqual(result.state, terminalState, `${terminalState} job must keep its state`);
    assert.strictEqual(result.cancelRungReached, null, `${terminalState} must record no rung`);
    assert.strictEqual(result.exitCode, 0, `${terminalState} cancel must exit 0`);
    console.log(`PASS: cancel test 6b — ${terminalState} job cancel is no-op`);
  });
}

// ===========================================================================
// 7. Architecture test: core/ contains no backend-specific cancellation
// ===========================================================================
{
  const coreDir = path.resolve(__dirname, '../../core');
  const coreFiles = fs.readdirSync(coreDir).filter(f => f.endsWith('.js'));

  const backendNames = ['codex', 'opencode', 'claude'];

  for (const file of coreFiles) {
    const fullPath = path.join(coreDir, file);
    const content = fs.readFileSync(fullPath, 'utf8');

    for (const name of backendNames) {
      const match = content.match(new RegExp(`\\b${name}\\b`, 'i'));
      if (match) {
        assert.fail(`core/${file} contains backend-specific reference "${match[0]}"`);
      }
    }
  }

  console.log('PASS: cancel test 7 — core/ has no backend-specific cancellation');
}

// ===========================================================================
// 8. cancel.request is written atomically and journaled before signalling
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const jobId = 'cancel-test-8';
  createJob(store, repoKey, jobId);
  const jobDir = store.getJobDir(repoKey, jobId);

  let onCancelCalled = false;
  let cancelRequestExistedBefore = false;

  const adapter = new FakeAdapter({
    declaredRungs: ['hard_kill'],
    facts: [],
    behaviors: {
      onCancel: (rung) => {
        if (!onCancelCalled) {
          cancelRequestExistedBefore = fs.existsSync(path.join(jobDir, 'cancel.request'));
          onCancelCalled = true;
        }
      },
    },
  });

  let processAlive = true;
  // Make the process die after the first RequestCancel completes so the test
  // can verify cancel.request existed before the call
  const originalRequestCancel = adapter.RequestCancel.bind(adapter);
  adapter.RequestCancel = (attempt, rung) => {
    const result = originalRequestCancel(attempt, rung);
    processAlive = false;
    return result;
  };
  await cancelJob({
    store, adapter, jobDir, repoKey, jobId,
    attempt: {}, attemptNum: 1,
    containment: null, executionToken: 'tok-test', pid: 1008,
    isProcessAliveFn: () => processAlive,
    rungWaitMs: 10, hardKillWaitMs: 10,
  });

  assert.ok(onCancelCalled, 'onCancel must have been called');
  assert.ok(cancelRequestExistedBefore, 'cancel.request must exist before RequestCancel is called');

  const journal = store.readJournal({ repoKey, jobId });
  const cancelJournalEntry = journal.find(e => e.detail && e.detail.cancel_requested_at);
  assert.ok(cancelJournalEntry, 'Journal must contain cancel_requested_at entry');
  assert.ok(cancelJournalEntry.seq < journal[journal.length - 1].seq,
    'Cancel journal entry must appear before the terminal state entry');

  console.log('PASS: cancel test 8 — cancel.request atomically written and journaled before signalling');
});

// ===========================================================================
// 9. Adapter rung ordering is preserved
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const jobId = 'cancel-test-9';
  createJob(store, repoKey, jobId);
  const jobDir = store.getJobDir(repoKey, jobId);

  const calledRungs = [];

  let processAlive = true;
  let rungCount = 0;
  const adapter = new FakeAdapter({
    declaredRungs: ['step_1', 'step_2', 'step_3'],
    facts: [],
    behaviors: {
      onCancel: (rung) => {
        calledRungs.push(rung);
        rungCount++;
        if (rungCount >= 3) processAlive = false;
      },
    },
  });

  await cancelJob({
    store, adapter, jobDir, repoKey, jobId,
    attempt: {}, attemptNum: 1,
    containment: null, executionToken: 'tok-test', pid: 1004,
    isProcessAliveFn: () => processAlive,
    rungWaitMs: 10, hardKillWaitMs: 10,
  });

  assert.deepStrictEqual(calledRungs, ['step_1', 'step_2', 'step_3'],
    'Rungs must be called in declared order');

  const status = store.readStatus({ repoKey, jobId });
  assert.strictEqual(status.backend_state.cancel_rung_reached, 'step_3',
    'The rung that kills the process must be recorded');

  console.log('PASS: cancel test 9 — adapter rung ordering is preserved');
});

// ===========================================================================
// Summary
// ===========================================================================
console.log('\nAll cancellation tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
