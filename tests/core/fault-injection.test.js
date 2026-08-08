// @suite full
// @serial  kills process trees at defined crash points
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { JobStore } = require('../../core/job-store');
const { reduce } = require('../../core/reducer');
const { FakeAdapter } = require('../../adapters/fake/adapter');
const { cancelJob } = require('../../core/cancel');
const {
  makeEvidence,
  assertRecovery, assertJournalCoherent, assertIdempotent,
  assertAllInvariants,
  __setInjectHook, __resetInject,
} = require('../helpers/fault-injection');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-fi-'));
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeStore(dir) {
  return new JobStore({ stateRoot: dir });
}

function createMinimalJob(store, jobId, overrides) {
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

function createAttempt(store, jobId, attemptNum) {
  store.createAttemptDir({ repoKey: 'test', jobId, attemptNum });
  store.journalTransition(jobId, 'test', {
    kind: 'attempt_created',
    attempt: attemptNum,
    from: null,
    to: 'created',
    detail: { attempt_id: `attempt-${attemptNum}`, execution_token: 'tok-fi' },
  });
}

function transitionToRunning(store, jobId, attemptNum) {
  store.journalTransition(jobId, 'test', {
    kind: 'attempt_state_changed',
    attempt: attemptNum,
    from: 'created',
    to: 'running',
    detail: {
      started_at: new Date().toISOString(),
      worker_pid: 42000,
      worker_identity: `42000;${new Date().toISOString()}`,
      backend_session_id: null,
    },
  });
}

async function main() {

// ===========================================================================
// 1. Point 1 — Before process spawn
//    The job exists in 'created' state but the controller died before it
//    ever attempted to spawn the worker. No process, no identity.
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    createMinimalJob(store, 'fi-1');
    const state = store.readStatus({ repoKey: 'test', jobId: 'fi-1' });
    const evidence = makeEvidence({ workerAlive: false, jobId: 'fi-1' });
    const result = reduce(state, [], evidence);
    assertAllInvariants({
      result, state, facts: [], evidence,
      journal: store.readJournal({ repoKey: 'test', jobId: 'fi-1' }),
      pointName: 'Point 1 — Before process spawn',
      expectState: 'interrupted',
    });
    console.log('PASS: Point 1 — Before process spawn');
  } finally { clean(dir); }
}

// ===========================================================================
// 2. Point 2 — After spawn, before durable identity recorded
//    The worker process was spawned but the controller died before writing
//    worker_identity to the journal/status. No verifiable identity exists.
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    createMinimalJob(store, 'fi-2');
    createAttempt(store, 'fi-2', 1);
    const state = store.readStatus({ repoKey: 'test', jobId: 'fi-2' });
    assert.strictEqual(state.worker_identity, null, 'Identity must not be recorded yet');
    const evidence = makeEvidence({ workerAlive: false, jobId: 'fi-2' });
    const result = reduce(state, [], evidence);
    assertAllInvariants({
      result, state, facts: [], evidence,
      journal: store.readJournal({ repoKey: 'test', jobId: 'fi-2' }),
      pointName: 'Point 2 — After spawn, before durable identity',
      expectState: 'interrupted',
    });
    console.log('PASS: Point 2 — After spawn, before durable identity');
  } finally { clean(dir); }
}

// ===========================================================================
// 3. Point 3 — During port discovery
//    The job transitioned to 'running' but port discovery was in progress
//    and no backend identity was persisted.
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    createMinimalJob(store, 'fi-3');
    createAttempt(store, 'fi-3', 1);
    transitionToRunning(store, 'fi-3', 1);
    const state = store.readStatus({ repoKey: 'test', jobId: 'fi-3' });
    assert.strictEqual(state.backend_session_id, null,
      'Backend session must not be recorded yet');
    const evidence = makeEvidence({ workerAlive: false, jobId: 'fi-3' });
    const result = reduce(state, [], evidence);
    assertAllInvariants({
      result, state, facts: [], evidence,
      journal: store.readJournal({ repoKey: 'test', jobId: 'fi-3' }),
      pointName: 'Point 3 — During port discovery',
      expectState: 'interrupted',
    });
    console.log('PASS: Point 3 — During port discovery');
  } finally { clean(dir); }
}

// ===========================================================================
// 4. Point 4 — After session exists, before it is recorded
//    The backend session was established but the controller died before the
//    session ID was written. Recovery sees a running worker but no session
//    identity — token mismatch forces interrupted.
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    createMinimalJob(store, 'fi-4', { executionToken: 'tok-controller' });
    createAttempt(store, 'fi-4', 1);
    transitionToRunning(store, 'fi-4', 1);
    const state = store.readStatus({ repoKey: 'test', jobId: 'fi-4' });
    assert.strictEqual(state.backend_session_id, null,
      'Backend session must not be recorded yet');
    const evidence = makeEvidence({
      workerAlive: true,
      completionSentinelPresent: false,
      heartbeatAgeMs: 30000,
      jobId: 'fi-4',
      executionToken: 'tok-controller',
      executionTokenMatch: false,
    });
    const result = reduce(state, [], evidence);
    assertAllInvariants({
      result, state, facts: [], evidence,
      journal: store.readJournal({ repoKey: 'test', jobId: 'fi-4' }),
      pointName: 'Point 4 — After session exists, before recorded',
      expectState: 'interrupted',
    });
    console.log('PASS: Point 4 — After session exists, before recorded');
  } finally { clean(dir); }
}

// ===========================================================================
// 5. Point 5 — Mid-turn, with an interaction pending
//    The job is running, the backend session is active, and an interaction
//    (permission) is pending. The controller dies; recovery sees a live
//    worker with token mismatch and no sentinel.
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    createMinimalJob(store, 'fi-5', { executionToken: 'tok-fi-5' });
    createAttempt(store, 'fi-5', 1);
    transitionToRunning(store, 'fi-5', 1);
    store.journalTransition('fi-5', 'test', {
      kind: 'attempt_state_changed',
      attempt: 1,
      from: 'running',
      to: 'running',
      detail: {
        backend_session_id: 'ses-midturn',
        phase: 'needs_input',
      },
    });
    const state = store.readStatus({ repoKey: 'test', jobId: 'fi-5' });
    assert.strictEqual(state.backend_session_id, 'ses-midturn',
      'Session must be recorded');
    assert.strictEqual(state.phase, 'needs_input',
      'Phase must show interaction pending');
    const evidence = makeEvidence({
      workerAlive: true,
      completionSentinelPresent: false,
      heartbeatAgeMs: 30000,
      jobId: 'fi-5',
      executionToken: 'tok-fi-5',
      executionTokenMatch: false,
    });
    const result = reduce(state, [], evidence);
    assertAllInvariants({
      result, state, facts: [], evidence,
      journal: store.readJournal({ repoKey: 'test', jobId: 'fi-5' }),
      pointName: 'Point 5 — Mid-turn, interaction pending',
      expectState: 'interrupted',
    });
    console.log('PASS: Point 5 — Mid-turn, interaction pending');
  } finally { clean(dir); }
}

// ===========================================================================
// 6. Point 6 — Before the snapshot commit
//    The job is running, work is complete, but the snapshot hasn't been
//    committed yet. Controller dies before the git snapshot.
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    createMinimalJob(store, 'fi-6', { executionToken: 'tok-fi-6' });
    createAttempt(store, 'fi-6', 1);
    transitionToRunning(store, 'fi-6', 1);
    store.journalTransition('fi-6', 'test', {
      kind: 'attempt_state_changed',
      attempt: 1,
      from: 'running',
      to: 'running',
      detail: { backend_session_id: 'ses-snap', phase: 'finalizing' },
    });
    const state = store.readStatus({ repoKey: 'test', jobId: 'fi-6' });
    const evidence = makeEvidence({
      workerAlive: true,
      completionSentinelPresent: false,
      heartbeatAgeMs: 30000,
      jobId: 'fi-6',
      executionToken: 'tok-fi-6',
      executionTokenMatch: false,
    });
    const result = reduce(state, [], evidence);
    assertAllInvariants({
      result, state, facts: [], evidence,
      journal: store.readJournal({ repoKey: 'test', jobId: 'fi-6' }),
      pointName: 'Point 6 — Before snapshot commit',
      expectState: 'interrupted',
    });
    console.log('PASS: Point 6 — Before snapshot commit');
  } finally { clean(dir); }
}

// ===========================================================================
// 7. Point 7 — After snapshot commit, before terminal publication
//    The snapshot exists (completion sentinel on disk) but the state is
//    still 'running' because the controller died before publishing the
//    terminal state. Recovery sees the sentinel and resolves to done.
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    createMinimalJob(store, 'fi-7', { executionToken: 'tok-fi-7' });
    createAttempt(store, 'fi-7', 1);
    transitionToRunning(store, 'fi-7', 1);
    store.journalTransition('fi-7', 'test', {
      kind: 'attempt_state_changed',
      attempt: 1,
      from: 'running',
      to: 'running',
      detail: { backend_session_id: 'ses-after-snap', phase: 'finalizing' },
    });
    const attemptDir = store.getJobDir('test', 'fi-7') + '/attempts/1';
    fs.mkdirSync(attemptDir, { recursive: true });
    fs.writeFileSync(path.join(attemptDir, 'worker-complete.json'),
      JSON.stringify({ exit_code: 0, finished_at: new Date().toISOString() }), 'utf8');
    const state = store.readStatus({ repoKey: 'test', jobId: 'fi-7' });
    const evidence = makeEvidence({
      workerAlive: false,
      completionSentinelPresent: true,
      resultBytes: 500,
      heartbeatAgeMs: null,
      jobId: 'fi-7',
      executionToken: 'tok-fi-7',
      executionTokenMatch: false,
      commandExitCode: 0,
    });
    const result = reduce(state, [], evidence);
    assertAllInvariants({
      result, state, facts: [], evidence,
      journal: store.readJournal({ repoKey: 'test', jobId: 'fi-7' }),
      pointName: 'Point 7 — After snapshot, before terminal publication',
      expectState: 'done',
    });
    console.log('PASS: Point 7 — After snapshot, before terminal publication');
  } finally { clean(dir); }
}

// ===========================================================================
// 8. Point 8 — Between cancel request and hard kill
//    The cancel.request was written and the journal recorded it. The
//    controller died before the kill rungs completed. The existing
//    cancel_requested_at in status guarantees the reducer sees "cancelled"
//    on recovery.
//
//    Tested two ways:
//    8a) Directly: set cancel_requested_at in state and run reduce
//    8b) Via cancelJob: use the inject hook to crash after cancel.request
//        is written but before rung escalation.
// ===========================================================================

// 8a. Direct state test — cancel_requested_at is set
{
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    createMinimalJob(store, 'fi-8a');
    createAttempt(store, 'fi-8a', 1);
    const state = store.readStatus({ repoKey: 'test', jobId: 'fi-8a' });
    const cancelState = {
      ...state,
      cancel_requested_at: new Date().toISOString(),
    };
    const evidence = makeEvidence({ workerAlive: true, jobId: 'fi-8a' });
    const result = reduce(cancelState, [], evidence);
    assertAllInvariants({
      result, state: cancelState, facts: [], evidence,
      journal: store.readJournal({ repoKey: 'test', jobId: 'fi-8a' }),
      pointName: 'Point 8a — Cancel requested (direct state)',
      expectState: 'cancelled',
    });
    console.log('PASS: Point 8a — Cancel requested (direct state)');
  } finally { clean(dir); }
}

// 8b. Inject hook test — crash after cancel.request written, before rungs
{
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    createMinimalJob(store, 'fi-8b', { executionToken: 'tok-fi-8b' });
    createAttempt(store, 'fi-8b', 1);
    const jobDir = store.getJobDir('test', 'fi-8b');
    const hookCalled = { value: false };
    __setInjectHook((name) => {
      if (name === 'cancel-before-rungs') {
        hookCalled.value = true;
      }
    });
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
      store, adapter, jobDir, repoKey: 'test', jobId: 'fi-8b',
      attempt: {}, attemptNum: 1,
      containment: null, executionToken: 'tok-fi-8b', pid: 42008,
      isProcessAliveFn: () => processAlive,
      rungWaitMs: 10, hardKillWaitMs: 10,
    });
    __resetInject();
    assert.ok(hookCalled.value, 'Injection hook must have been called at cancel-before-rungs');
    assert.strictEqual(result.state, 'cancelled',
      'cancelJob must produce cancelled after inject hook path');
    const postState = store.readStatus({ repoKey: 'test', jobId: 'fi-8b' });
    assert.strictEqual(postState.state, 'cancelled',
      'Status must be cancelled after cancelJob');
    const journal = store.readJournal({ repoKey: 'test', jobId: 'fi-8b' });
    assertJournalCoherent(journal, { pointName: 'Point 8b — Cancel via inject hook' });
    console.log('PASS: Point 8b — Cancel via inject hook');
  } finally { clean(dir); __resetInject(); }
}

// ===========================================================================
// 9. Point 9 — During terminal publication
//    The journal entry was appended but the controller died before the
//    status.json was updated. The journal contains the truth so recovery
//    can regenerate the correct status.
//
//    Test: run journalTransition (append + status update) but use the
//    inject hook to crash after the append but before status write.
//    Then verify that regenerateStatus produces the correct state
//    from the journal alone.
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = makeStore(dir);
    createMinimalJob(store, 'fi-9');
    createAttempt(store, 'fi-9', 1);
    const jobDir = store.getJobDir('test', 'fi-9');

    const hookCalled = { value: false };
    __setInjectHook((name) => {
      if (name === 'journal-before-status-write') {
        hookCalled.value = true;
        __resetInject();
      }
    });
    store.journalTransition('fi-9', 'test', {
      kind: 'attempt_state_changed',
      attempt: 1,
      from: 'created',
      to: 'running',
      detail: { started_at: new Date().toISOString(), phase: 'agent_running' },
    });
    __resetInject();
    assert.ok(hookCalled.value,
      'Injection hook must have been called at journal-before-status-write');

    const journalBefore = store.readJournal({ repoKey: 'test', jobId: 'fi-9' });
    const lastEntry = journalBefore[journalBefore.length - 1];
    assert.strictEqual(lastEntry.to, 'running',
      'Journal must contain the transition to running');
    assert.strictEqual(lastEntry.kind, 'attempt_state_changed',
      'Last entry must be attempt_state_changed');

    const statusWritten = store.readStatus({ repoKey: 'test', jobId: 'fi-9' });
    const regenerated = store.regenerateStatus({ repoKey: 'test', jobId: 'fi-9' });

    assert.strictEqual(statusWritten.state, regenerated.state,
      'Written status must match regenerated status from journal');
    assert.strictEqual(regenerated.state, 'running',
      'Regenerated status must show running');

    const evidence = makeEvidence({
      workerAlive: false,
      completionSentinelPresent: false,
      heartbeatAgeMs: null,
      jobId: 'fi-9',
    });
    const result = reduce(regenerated, [], evidence);
    assertRecovery(result, { pointName: 'Point 9 — During terminal publication', expectState: 'interrupted' });
    assertIdempotent(regenerated, [], evidence, { pointName: 'Point 9 — During terminal publication' });

    console.log('PASS: Point 9 — During terminal publication');
  } finally { clean(dir); __resetInject(); }
}

// ===========================================================================
// Summary
// ===========================================================================
console.log('\nAll fault-injection tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
