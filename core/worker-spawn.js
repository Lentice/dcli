// One module owns spawning the detached worker. Two callers used to carry two
// copies of the spawn body — the initial submit (core/commands/submit.js) and
// the queued relaunch (the setSpawnWorker callback in core/commands/worker.js)
// — that differed in stdio handling, error handling, the `from` recorded for
// launch identity, and the DCLI_QUEUE_CLAIM_PATH environment key. A fix to one
// copy silently left the other path different, and the two paths are "the job
// you submitted" and "the job that waited in the queue first" (ticket 97).
// The queue claim is a parameter now; everything else is owned here once.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { removeWorktree } = require('./worktree');

function readSpawnFailureWorktree({ store, stateRoot, repoKey, jobId }) {
  try {
    const status = store.readStatus({ repoKey, jobId });
    if (status.worktree && status.worktree.path) return status.worktree.path;
  } catch {}
  try {
    const params = JSON.parse(fs.readFileSync(
      path.join(stateRoot, 'jobs', repoKey, jobId, 'params.json'), 'utf8',
    ));
    return params.worktreePath || null;
  } catch {
    return null;
  }
}

function journalWorkerSpawnFailure({ store, stateRoot, repoRoot, repoKey, jobId, error }) {
  const worktreePath = readSpawnFailureWorktree({ store, stateRoot, repoKey, jobId });
  try {
    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed',
      attempt: 1,
      from: 'created',
      to: 'failed',
      detail: {
        finished_at: new Date().toISOString(),
        phase: 'terminal',
        failure_reason: 'worker_spawn_failed',
        failure: error && error.message ? error.message : 'Worker failed to launch',
        ...(worktreePath ? { worktree_path: worktreePath } : {}),
      },
    });
  } catch {}
  if (worktreePath) removeWorktree(repoRoot, worktreePath);
  if (error && !error.exitCode) error.exitCode = 18;
}

/**
 * Spawn the detached worker for a job and persist its launch identity before
 * the child can begin work (ticket 84's ordering).
 *
 * @param {Object}   a
 * @param {Object}   a.store
 * @param {string}   a.stateRoot
 * @param {string}   a.backend
 * @param {string}   a.jobId
 * @param {string}   a.repoKey
 * @param {string}   a.repoRoot
 * @param {number|null} a.hardTimeoutSec
 * @param {string}   a.executionToken
 * @param {string|null} [a.queueClaimPath]  non-null only on the queued relaunch;
 *                                          controls DCLI_QUEUE_CLAIM_PATH and
 *                                          the `from` recorded for the launch
 * @returns {{ child: import('node:child_process').ChildProcess,
 *             launched: Promise<void> }}
 */
function spawnWorker({ store, stateRoot, backend, jobId, repoKey, repoRoot, hardTimeoutSec, executionToken, queueClaimPath = null }) {
  const workerScript = path.resolve(__dirname, 'commands', 'worker.js');
  const workerLog = fs.openSync(path.join(stateRoot, 'jobs', repoKey, jobId, 'attempts', '1', 'worker.log'), 'a');
  const hardTimeoutMs = hardTimeoutSec && hardTimeoutSec > 0 ? hardTimeoutSec * 1000 : 0;

  // The environment handed to the child is identical between the two call
  // sites except for DCLI_QUEUE_CLAIM_PATH, which is set only when the spawn
  // is the queued relaunch.
  const env = {
    ...process.env,
    DCLI_WORKER: '1',
    DCLI_STATE_ROOT: stateRoot,
    DCLI_BACKEND: backend,
    DCLI_JOB_ID: jobId,
    DCLI_REPO_KEY: repoKey,
    DCLI_REPO_ROOT: repoRoot,
    DCLI_WORKER_HARD_TIMEOUT_MS: String(hardTimeoutMs),
  };
  if (queueClaimPath !== null) env.DCLI_QUEUE_CLAIM_PATH = queueClaimPath;

  let child;
  try {
    child = spawn(process.execPath, [workerScript], {
      detached: true,
      windowsHide: true,
      // The caller exits independently; redirect instead of creating an
      // undrained pipe, while keeping worker diagnostics durable.
      stdio: ['ignore', workerLog, workerLog],
      env,
    });
  } finally {
    fs.closeSync(workerLog);
  }

  // Persist the launch identity the instant the process exists, before the
  // child can do anything: this is what lets `cancel` kill something real and
  // reconciliation prove death (AGENTS.md #5). A crash between spawn and this
  // journal is exactly the window ticket 84 closed. The queued relaunch
  // records `from: 'queued'`, the initial submit `from: 'created'`.
  try {
    store.recordWorkerLaunch({
      jobId, repoKey, attempt: 1, from: queueClaimPath !== null ? 'queued' : 'created',
      pid: child.pid, executionToken,
    });
  } catch (err) {
    try { child.kill(); } catch {}
    throw err;
  }

  const launched = new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const journalSpawnFailure = (err) => {
      journalWorkerSpawnFailure({ store, stateRoot, repoRoot, repoKey, jobId, error: err });
      settle();
    };
    const timer = setTimeout(settle, 1000);
    child.once('spawn', settle);
    child.once('error', journalSpawnFailure);
    // Allow the parent to exit independently after the creation result is known.
    child.unref();
  });

  return { child, launched };
}

module.exports = { spawnWorker, journalWorkerSpawnFailure };
