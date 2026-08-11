// Detached worker process for background job execution.
// Spawned by submit command. Reads job params from the job directory, then
// hands the attempt to driveAttempt() — the same driver the foreground
// `run`/`resume` paths use — and publishes the completion sentinel from the
// terminal state it returns.
//
// Environment:
//   DCLI_WORKER=1  DCLI_STATE_ROOT=<path>  DCLI_BACKEND=<name>
//   DCLI_JOB_ID=<id>  DCLI_REPO_KEY=<key>  DCLI_REPO_ROOT=<path>
//   DCLI_WORKER_HARD_TIMEOUT_MS=<ms>  DCLI_QUEUE_CLAIM_PATH=<path>

if (process.env.DCLI_WORKER !== '1') {
  console.error('worker.js requires DCLI_WORKER=1');
  process.exit(1);
}

const fs = require('fs');
const path = require('path');
const { writeJsonFileAtomic } = require('../fs-text');
const { persistInitFiles } = require('../result-artifact');
const { driveAttempt, createCancelSignal } = require('./attempt-driver');
const { generateExecutionToken, workerIdentityDetail } = require('../process-identity');
const { spawnWorker } = require('../worker-spawn');

async function main() {
  const stateRoot = process.env.DCLI_STATE_ROOT;
  const backendName = process.env.DCLI_BACKEND;
  const jobId = process.env.DCLI_JOB_ID;
  const repoKey = process.env.DCLI_REPO_KEY;
  const repoRoot = process.env.DCLI_REPO_ROOT;
  const hardTimeoutMsRaw = parseInt(process.env.DCLI_WORKER_HARD_TIMEOUT_MS || '0', 10);
  const queueClaimPath = process.env.DCLI_QUEUE_CLAIM_PATH || null;

  if (!stateRoot || !backendName || !jobId || !repoKey || !repoRoot) {
    console.error('Worker: missing required env vars');
    journalFailure(null, null, repoKey, jobId, stateRoot, 'worker_startup_failed', 'Missing required env vars');
    process.exit(1);
  }

  const { JobStore } = require('../job-store');
  const { AdmissionController } = require('../admission');
  const { getBackendLimits } = require('../../adapters/registry');
  const store = new JobStore({ stateRoot });

  const jobDir = store.getJobDir(repoKey, jobId);

  let params;
  try {
    params = JSON.parse(fs.readFileSync(path.join(jobDir, 'params.json'), 'utf8'));
  } catch (err) {
    journalFailure(store, null, repoKey, jobId, null, 'worker_startup_failed', `Cannot read params: ${err.message}`);
    process.exit(1);
  }
  const executionToken = params.executionToken || generateExecutionToken();
  const worktreePath = params.worktreePath || null;
  const worktreeBaseCommit = params.worktreeBaseCommit || null;

  let prompt;
  try {
    prompt = fs.readFileSync(path.join(jobDir, 'prompt.txt'), 'utf8');
  } catch (err) {
    journalFailure(store, null, repoKey, jobId, null, 'worker_startup_failed', `Cannot read prompt: ${err.message}`);
    process.exit(1);
  }

  // Acquire admission slot (dequeue spawns a fresh worker when one frees).
  const admission = new AdmissionController({ stateRoot, backendLimits: getBackendLimits() });
  admission.setSpawnWorker((entry) => {
    // The queued relaunch goes through the same spawn path as the initial
    // submit (core/worker-spawn.js); the queue claim is a parameter.
    spawnWorker({
      store,
      stateRoot,
      backend: entry.backend,
      jobId: entry.jobId,
      repoKey: entry.repoKey || 'unknown',
      repoRoot: entry.repoRoot || stateRoot,
      hardTimeoutSec: entry.hardTimeoutMs && entry.hardTimeoutMs > 0 ? entry.hardTimeoutMs / 1000 : null,
      executionToken: entry.executionToken || executionToken,
      queueClaimPath: entry.queueClaimPath,
    });
  });
  // Reconcile AFTER the spawn callback is registered: the queue nudge inside
  // reconcile() dispatches through it.
  admission.reconcile();

  const slotResult = admission.acquireSlot(backendName);
  if (!slotResult.acquired) {
    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed',
      attempt: null,
      from: 'created',
      to: 'queued',
      detail: {
        phase: 'queued', queue_reason: slotResult.reason,
        worker_pid: null, worker_identity: null,
      },
    });
    if (queueClaimPath && fs.existsSync(queueClaimPath)) {
      try { fs.renameSync(queueClaimPath, path.join(stateRoot, 'queue', `${jobId}.json`)); } catch {}
    } else {
      admission.enqueueJob(backendName, jobId, {
        repoKey, repoRoot, hardTimeoutMs: hardTimeoutMsRaw > 0 ? hardTimeoutMsRaw : 0,
        executionToken,
      });
    }
    process.exit(0);
  }
  const slotId = slotResult.slotId;
  process.env.DCLI_SLOT_ID = slotId;

  let adapter;
  try {
    const adapterPath = path.resolve(__dirname, '..', '..', 'adapters', backendName, 'adapter');
    const { getBackground } = require('../../adapters/registry');
    const mod = require(adapterPath);
    const AdapterClass = mod[getBackground(backendName).class];
    if (!AdapterClass) throw new Error(`Adapter module for "${backendName}" does not export class ${getBackground(backendName).class}`);
    adapter = new AdapterClass(params._adapterScript || {});
  } catch (err) {
    journalFailure(store, slotId, repoKey, jobId, null, 'worker_startup_failed', `Cannot load adapter: ${err.message}`);
    dropQueueClaim(queueClaimPath);
    admission.releaseSlot(slotId);
    process.exit(1);
  }

  try {
    adapter.ValidateRequest({
      model: params.model || null,
      canonicalDir: worktreePath || repoRoot,
      reasoningEffort: params.reasoningEffort || null,
      variant: params.variant || null,
      effort: params.effort || null,
      access: params.access || 'read-only',
    });
    adapter.DetectVersion();
  } catch (err) {
    journalFailure(store, slotId, repoKey, jobId, null, 'validation_failed', err.message);
    dropQueueClaim(queueClaimPath);
    admission.releaseSlot(slotId);
    process.exit(2);
  }

  const attemptNum = 1;
  try {
    store.createAttemptDir({ repoKey, jobId, attemptNum });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      journalFailure(store, slotId, repoKey, jobId, null, 'worker_startup_failed', `Cannot create attempt dir: ${err.message}`);
      dropQueueClaim(queueClaimPath);
      admission.releaseSlot(slotId);
      process.exit(1);
    }
  }

  persistInitFiles({
    store, repoKey, jobId, attemptNum, prompt,
    commandParams: {
      model: params.model || null,
      access: params.access || 'read-only',
      mode: params.mode || 'run',
      hardTimeoutMs: params.hardTimeoutMs || 0,
      reasoningEffort: params.reasoningEffort || null,
      variant: params.variant || null,
      effort: params.effort || null,
    },
  });

  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created',
    attempt: attemptNum,
    from: null,
    to: 'created',
    detail: { attempt_id: `attempt-${attemptNum}`, execution_token: executionToken },
  });

  // Persist the launch identity the instant the process exists: this is what
  // lets `cancel` kill something real and reconciliation prove death. Holding
  // it only in the launcher's memory left jobs stuck `running` (AGENTS.md #5).
  // The implement-mode worktree details are journaled here — the mirror of
  // what job-setup journals on the foreground path — so diff/apply/cleanup
  // can find the worktree even though this attempt was launched by the worker.
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed',
    attempt: attemptNum,
    from: 'created',
    to: 'running',
    detail: {
      started_at: new Date().toISOString(),
      phase: 'agent_running',
      ...workerIdentityDetail(),
      ...(worktreePath ? { worktree_path: worktreePath, worktree_base_commit: worktreeBaseCommit } : {}),
    },
  });

  // The launch is durable now — the journal says `running` — so the queue
  // claim can go. Dropping it earlier opened a window where a reconciler saw
  // a `queued` job with no entry and no worker and retired it while the
  // backend was about to start (ticket 107).
  dropQueueClaim(queueClaimPath);

  // Every terminal exit routes through here so the completion sentinel — the
  // evidence reconciliation reads to tell "finished" from "died" — cannot be
  // written on some paths and forgotten on others. `state` is recorded beside
  // the exit code because the two are not the same claim: an `interrupted`
  // attempt exits 0, and a reader that had only the code turned that into
  // `done`. Written after the driver's terminal journal entry, never before.
  function finish(code, state) {
    try {
      writeJsonFileAtomic(
        path.join(jobDir, 'attempts', String(attemptNum), 'worker-complete.json'),
        { exit_code: code, state: state || null, finished_at: new Date().toISOString() }
      );
    } catch {}
    process.exit(code);
  }

  // driveAttempt owns the hard-timeout rung walk, the cancel.request watcher,
  // the heartbeat cadence, result persistence, the terminal journal, dispose
  // and the slot release. This process hosts it and publishes the sentinel.
  const result = await driveAttempt({
    store, adapter, repoKey, repoRoot, jobId, attemptNum,
    prompt,
    request: params,
    worktreePath, worktreeBaseCommit,
    hardTimeoutSec: hardTimeoutMsRaw > 0 ? hardTimeoutMsRaw / 1000 : null,
    admission, acquiredSlotId: slotId,
    cancelSignal: createCancelSignal({ jobDir }),
    fallbackSessionId: params.fallbackSessionId || null,
  });

  finish(result.exitCode, result.terminalState);
}

function journalFailure(store, slotId, repoKey, jobId, stateRoot, reason, message) {
  try {
    if (!store && stateRoot) {
      const { JobStore } = require('../job-store');
      store = new JobStore({ stateRoot });
    }
    if (store && repoKey && jobId) {
      store.journalTransition(jobId, repoKey, {
        kind: 'attempt_state_changed',
        attempt: 1,
        from: 'created',
        to: 'failed',
        detail: { finished_at: new Date().toISOString(), phase: 'terminal', failure_reason: reason, failure: message },
      });
    }
  } catch {}
}

// Remove the queue launch claim once it is no longer needed. Idempotent: a
// claim that cancel already removed (or that never existed) is fine.
function dropQueueClaim(queueClaimPath) {
  if (!queueClaimPath) return;
  try { fs.unlinkSync(queueClaimPath); } catch {}
}

function writeCrashSentinel(stateRoot, repoKey, jobId, code, state) {
  try {
    const jobDir = path.join(stateRoot, 'jobs', repoKey, jobId);
    writeJsonFileAtomic(
      path.join(jobDir, 'attempts', '1', 'worker-complete.json'),
      { exit_code: code, state, finished_at: new Date().toISOString() }
    );
  } catch {}
}

main().catch(err => {
  console.error('Worker fatal:', err.message);
  try {
    const s = new (require('../job-store').JobStore)({ stateRoot: process.env.DCLI_STATE_ROOT });
    s.journalTransition(process.env.DCLI_JOB_ID, process.env.DCLI_REPO_KEY, {
      kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'failed',
      detail: { finished_at: new Date().toISOString(), phase: 'terminal', failure_reason: 'worker_crash', failure: err.message },
    });
  } catch {}
  writeCrashSentinel(
    process.env.DCLI_STATE_ROOT,
    process.env.DCLI_REPO_KEY,
    process.env.DCLI_JOB_ID,
    1,
    'failed'
  );
  try {
    const { AdmissionController } = require('../admission');
    const { getBackendLimits } = require('../../adapters/registry');
    const admission = new AdmissionController({
      stateRoot: process.env.DCLI_STATE_ROOT,
      backendLimits: getBackendLimits(),
    });
    admission.releaseSlot(process.env.DCLI_SLOT_ID);
  } catch {}
  process.exit(1);
});
