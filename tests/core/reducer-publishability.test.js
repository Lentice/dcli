const assert = require('node:assert');
const { reduce } = require('../../core/reducer');

// ---------------------------------------------------------------------------
// Pure publishability suite (ticket 101). No filesystem: every evidence
// combination is asserted directly against reduce().
//
// publishable is true only on POSITIVE evidence that the owner is gone:
//   - the completion sentinel is present, or
//   - workerAlive === false, or
//   - the identityless-and-past-its-own-deadline rule.
// A stale heartbeat with unknown liveness may *display* `interrupted` but
// must never be publishable.
// ---------------------------------------------------------------------------

function runningState(overrides = {}) {
  return {
    state: 'running',
    phase: 'agent_running',
    job_id: 'publish-1',
    cancel_requested_at: null,
    hard_timeout_sec: null,
    started_at: null,
    failure_reason: null,
    backend_session_id: 'ses_pub',
    failure: null,
    worker_pid: 1234,
    worker_identity: '1234;os:2026-01-01T00:00:00.0000000Z',
    ...overrides,
  };
}

// ===========================================================================
// 1. Worker alive — not publishable, stays running
// ===========================================================================
{
  const result = reduce(runningState(), [], {
    workerAlive: true,
    completionSentinelPresent: false,
    heartbeatAgeMs: 2000,
    jobId: 'publish-1',
  });
  assert.strictEqual(result.state, 'running', 'a live worker stays running');
  assert.strictEqual(result.publishable, false,
    'a live worker publishes its own outcome — never an inference');
}

console.log('PASS: worker alive → running, publishable=false');

// ===========================================================================
// 2. Worker dead (no sentinel, stale heartbeat) — publishable interrupted
// ===========================================================================
{
  const result = reduce(runningState(), [], {
    workerAlive: false,
    completionSentinelPresent: false,
    heartbeatAgeMs: 30000,
    jobId: 'publish-1',
  });
  assert.strictEqual(result.state, 'interrupted', 'worker gone must reduce to interrupted');
  assert.strictEqual(result.publishable, true,
    'workerAlive === false is positive evidence the owner is gone');
}

console.log('PASS: worker dead → interrupted, publishable=true');

// ===========================================================================
// 3. Liveness unknown with a stale heartbeat — displays interrupted but is
//    NOT publishable
// ===========================================================================
{
  const result = reduce(runningState(), [], {
    workerAlive: null,
    completionSentinelPresent: false,
    heartbeatAgeMs: 30000,
    jobId: 'publish-1',
  });
  assert.strictEqual(result.state, 'interrupted',
    'a stale heartbeat is enough to display interrupted');
  assert.strictEqual(result.publishable, false,
    'a stale heartbeat with unknown liveness is not positive evidence the owner is gone');
}

console.log('PASS: liveness unknown + stale heartbeat → interrupted, publishable=false');

// ===========================================================================
// 4. Completion sentinel present — publishable
// ===========================================================================
{
  const result = reduce(runningState(), [], {
    workerAlive: false,
    completionSentinelPresent: true,
    sentinelState: 'done',
    commandExitCode: 0,
    heartbeatAgeMs: null,
    jobId: 'publish-1',
  });
  assert.strictEqual(result.state, 'done', 'sentinel + gone worker must reduce to done');
  assert.strictEqual(result.publishable, true,
    'a completion sentinel is positive evidence the owner is gone');
}

console.log('PASS: sentinel present → done, publishable=true');

// ===========================================================================
// 5. Identityless record within its own deadline — not publishable, still
//    running
// ===========================================================================
{
  const state = runningState({
    worker_pid: null,
    worker_identity: null,
    started_at: new Date(Date.now() - 60000).toISOString(),
    hard_timeout_sec: 3600,
  });
  const result = reduce(state, [], {
    workerAlive: null,
    completionSentinelPresent: false,
    heartbeatAgeMs: null,
    jobId: 'publish-1',
    workerIdentityMissing: true,
  });
  assert.strictEqual(result.state, 'running',
    'an identityless job inside its deadline must remain running');
  assert.strictEqual(result.publishable, false,
    'a job that might still be working must never be retired by inference');
}

console.log('PASS: identityless within deadline → running, publishable=false');

// ===========================================================================
// 6. Identityless record past its own deadline — publishable interrupted,
//    naming the missing identity
// ===========================================================================
{
  const state = runningState({
    worker_pid: null,
    worker_identity: null,
    started_at: new Date(Date.now() - 60000).toISOString(),
    hard_timeout_sec: 1,
  });
  const result = reduce(state, [], {
    workerAlive: null,
    completionSentinelPresent: false,
    heartbeatAgeMs: null,
    jobId: 'publish-1',
    workerIdentityMissing: true,
  });
  assert.strictEqual(result.state, 'interrupted',
    'an identityless job past its own deadline must resolve to interrupted');
  assert.strictEqual(result.failure_reason, 'worker_identity_missing',
    'the terminal reason must name the missing launch identity');
  assert.strictEqual(result.publishable, true,
    'an elapsed recorded deadline is the sole exception: no worker can still be inside the budget');
}

console.log('PASS: identityless past deadline → interrupted, publishable=true');

// ===========================================================================
// 7. Every reduce() result carries a boolean publishable
// ===========================================================================
{
  const combos = [
    ['alive', runningState(), { workerAlive: true, completionSentinelPresent: false, heartbeatAgeMs: 2000, jobId: 'publish-1' }],
    ['dead', runningState(), { workerAlive: false, completionSentinelPresent: false, heartbeatAgeMs: 30000, jobId: 'publish-1' }],
    ['stale-unknown', runningState(), { workerAlive: null, completionSentinelPresent: false, heartbeatAgeMs: 30000, jobId: 'publish-1' }],
    ['sentinel', runningState(), { workerAlive: false, completionSentinelPresent: true, sentinelState: 'done', commandExitCode: 0, heartbeatAgeMs: null, jobId: 'publish-1' }],
    ['identityless-in', runningState({ worker_pid: null, worker_identity: null, started_at: new Date(Date.now() - 60000).toISOString(), hard_timeout_sec: 3600 }), { workerAlive: null, completionSentinelPresent: false, heartbeatAgeMs: null, jobId: 'publish-1', workerIdentityMissing: true }],
    ['identityless-past', runningState({ worker_pid: null, worker_identity: null, started_at: new Date(Date.now() - 60000).toISOString(), hard_timeout_sec: 1 }), { workerAlive: null, completionSentinelPresent: false, heartbeatAgeMs: null, jobId: 'publish-1', workerIdentityMissing: true }],
    ['terminal-idempotent', { state: 'done', phase: 'terminal', job_id: 'publish-1', failure_reason: null, backend_session_id: null, failure: null }, { jobId: 'publish-1' }],
  ];
  for (const [name, state, evidence] of combos) {
    const result = reduce(state, [], evidence);
    assert.strictEqual(typeof result.publishable, 'boolean',
      `combo "${name}" must return a boolean publishable, got ${JSON.stringify(result.publishable)}`);
  }
}

console.log('PASS: every reduce() result carries a boolean publishable');

console.log('\nAll publishability tests passed.');
