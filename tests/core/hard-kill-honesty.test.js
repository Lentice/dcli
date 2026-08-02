// Hard-kill honesty contract.
//
// AGENTS.md Mistake #5: "a `cancel` that wrote `cancelled` while killing nothing".
// AGENTS.md Mistake #7: a failure must never read as a clean result.
//
// The backend process tree is spawned by the adapter with a plain `spawn`, so it is
// NOT inside any Job Object. `core/containment.js`'s helper can only terminate a Job
// Object it created itself via its own `spawn` command — it has no "terminate an
// arbitrary pid" command at all (see native/windows-job-helper/Program.cs HandleTerminate,
// which returns `{type:"error",error:"no active job"}` when `_jobHandle` is zero).
//
// Until the adapters spawn through a ContainmentContext, no contained tree kill is
// possible. These tests pin the requirement that we say so honestly rather than
// recording a kill that did not happen.

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { JobStore } = require('../../core/job-store');
const { FakeAdapter } = require('../../adapters/fake/adapter');
const { cancelJob } = require('../../core/cancel');
const containment = require('../../core/containment');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-killhonesty-'));
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

async function main() {

  // =========================================================================
  // 1. The unavailable-containment fallback does not claim the adapter's rung.
  //    Every rung fails and the process stays alive. Recording 'hard_kill' here
  //    is indistinguishable from "the adapter's own hard_kill rung succeeded",
  //    which is the ambiguity this test closes.
  // =========================================================================
  await withTempDir(async (dir) => {
    const store = new JobStore({ stateRoot: dir });
    const repoKey = 'repo-a';
    const jobId = 'job-fallback-unavailable';
    createJob(store, repoKey, jobId);
    const jobDir = store.getJobDir(repoKey, jobId);

    const adapter = new FakeAdapter({ declaredRungs: ['session_abort', 'hard_kill'], facts: [] });

    const result = await cancelJob({
      store, adapter, jobDir, repoKey, jobId,
      attempt: {}, attemptNum: 1,
      containment: null,
      executionToken: 'tok-test',
      pid: 2001,
      isProcessAliveFn: () => true,
      rungWaitMs: 5,
      hardKillWaitMs: 5,
    });

    assert.notStrictEqual(result.cancelRungReached, 'hard_kill',
      "With containment unavailable and the process still alive, the fallback must not " +
      "record 'hard_kill' — that value means the adapter's own hard_kill rung worked.");
    assert.strictEqual(result.cancelRungReached, 'containment_unavailable',
      'The fallback must name why no tree kill happened');
    assert.strictEqual(result.warning, 'termination_unconfirmed',
      'A surviving process must still warn termination_unconfirmed');
    assert.strictEqual(result.exitCode, 21,
      'A surviving process must still exit 21');

    console.log('PASS: hard-kill honesty 1 — unavailable containment is named, not disguised as a rung');
  });

  // =========================================================================
  // 2. An adapter rung that genuinely kills still records that rung.
  //    Guards against "fix the lie by making every cancel look unavailable".
  // =========================================================================
  await withTempDir(async (dir) => {
    const store = new JobStore({ stateRoot: dir });
    const repoKey = 'repo-b';
    const jobId = 'job-rung-works';
    createJob(store, repoKey, jobId);
    const jobDir = store.getJobDir(repoKey, jobId);

    let alive = true;
    const adapter = new FakeAdapter({
      declaredRungs: ['graceful_stop', 'hard_kill'],
      facts: [],
      behaviors: { onCancel: (rung) => { if (rung === 'hard_kill') alive = false; } },
    });

    const result = await cancelJob({
      store, adapter, jobDir, repoKey, jobId,
      attempt: {}, attemptNum: 1,
      containment: null,
      executionToken: 'tok-test',
      pid: 2002,
      isProcessAliveFn: () => alive,
      rungWaitMs: 5,
      hardKillWaitMs: 5,
    });

    assert.strictEqual(result.cancelRungReached, 'hard_kill',
      "A rung that actually killed the process must still be recorded as that rung");
    assert.strictEqual(result.state, 'cancelled');
    assert.strictEqual(result.exitCode, 0);

    const status = store.readStatus({ repoKey, jobId });
    assert.strictEqual(status.backend_state.cancel_rung_reached, 'hard_kill');

    console.log('PASS: hard-kill honesty 2 — a real rung kill is still recorded as that rung');
  });

  // =========================================================================
  // 3. A contained tree kill that actually runs is recorded distinctly, and a
  //    kill reporting survivors is NOT reported as a success.
  // =========================================================================
  await withTempDir(async (dir) => {
    const store = new JobStore({ stateRoot: dir });
    const repoKey = 'repo-c';
    const jobId = 'job-survivors';
    createJob(store, repoKey, jobId);
    const jobDir = store.getJobDir(repoKey, jobId);

    const adapter = new FakeAdapter({ declaredRungs: ['hard_kill'], facts: [] });

    let terminateCalls = 0;
    const fakeContainment = {
      terminate: async () => {
        terminateCalls++;
        // The helper's own contract: terminated=false means the tree survived.
        return { terminated: false, survivors: [4242] };
      },
    };

    const result = await cancelJob({
      store, adapter, jobDir, repoKey, jobId,
      attempt: {}, attemptNum: 1,
      containment: fakeContainment,
      executionToken: 'tok-test',
      pid: 2003,
      isProcessAliveFn: () => true,
      rungWaitMs: 5,
      hardKillWaitMs: 5,
    });

    assert.strictEqual(terminateCalls, 1, 'containment.terminate must be attempted once');
    assert.notStrictEqual(result.cancelRungReached, 'hard_kill',
      'A containment kill is not the adapter hard_kill rung');
    assert.strictEqual(result.cancelRungReached, 'contained_tree_kill',
      'An attempted contained kill must be named as such');
    assert.strictEqual(result.warning, 'termination_unconfirmed',
      'Survivors reported by the helper must not read as a clean kill');
    assert.strictEqual(result.exitCode, 21);

    console.log('PASS: hard-kill honesty 3 — survivors are not reported as a clean kill');
  });

  // =========================================================================
  // 4. core/containment.js must not export a pid-based terminateTree that
  //    reports success while killing nothing.
  //
  //    The helper protocol has exactly two commands (spawn, terminate) and
  //    terminate only ever acts on the Job Object the helper itself created.
  //    A pid-argv "terminateTree(pid)" therefore cannot work, and the version
  //    that existed resolved `{terminated: true}` off the helper's exit code
  //    after the helper had answered `{"type":"error","error":"no active job"}`.
  //
  //    If a future ticket implements a genuine pid-based tree kill (a new helper
  //    command), this assertion is the place to update — deliberately, with the
  //    helper change in the same commit.
  // =========================================================================
  assert.strictEqual(typeof containment.terminateTree, 'undefined',
    'core/containment.js must not export terminateTree until the native helper has a ' +
    'command that can terminate a tree it did not spawn. See docs/tickets/78.');

  console.log('PASS: hard-kill honesty 4 — no pid-based terminateTree is exported');

  // =========================================================================
  // 5. A hard-timeout journal entry's `kill_skipped` reaches status.json.
  //    status.json is a whitelist projection, so a detail field that is not
  //    explicitly projected is silently dropped — which would make the worker's
  //    honest "I did not kill the tree" record invisible to every reader.
  // =========================================================================
  await withTempDir(async (dir) => {
    const store = new JobStore({ stateRoot: dir });
    const repoKey = 'repo-d';
    const jobId = 'job-timeout-projection';
    createJob(store, repoKey, jobId);

    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'running',
      detail: { started_at: new Date().toISOString(), phase: 'agent_running' },
    });
    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed', attempt: 1, from: 'running', to: 'timed_out',
      detail: {
        finished_at: new Date().toISOString(), command_exit_code: null,
        phase: 'terminal', failure_reason: 'hard_timeout', kill_skipped: 'not_contained',
      },
    });

    const status = store.readStatus({ repoKey, jobId });
    assert.strictEqual(status.state, 'timed_out');
    assert.strictEqual(status.failure_reason, 'hard_timeout',
      'AGENTS.md: reconciliation must preserve failure_reason');
    assert.strictEqual(status.kill_skipped, 'not_contained',
      'kill_skipped must be projected into status.json, or the honest record is invisible');

    console.log('PASS: hard-kill honesty 5 — kill_skipped survives into status.json');
  });
}

main().then(() => {
  console.log('\nAll hard-kill honesty tests passed');
}).catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
