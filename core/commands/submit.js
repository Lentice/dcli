const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { loadJobOrThrow } = require('./index');
const { openAttempt } = require('../job-setup');
const { writeTextFileAtomic, writeJsonFileAtomic } = require('../fs-text');
const { generateExecutionToken } = require('../process-identity');

async function executeSubmit({ store, adapter, repoKey, repoRoot, prompt, hardTimeoutSec, group, label, model, access, reasoningEffort, variant, effort, admission, resumeJobId, stateRoot, backend }) {
  stateRoot = stateRoot || store._stateRoot;
  repoRoot = repoRoot || process.cwd();

  let parentStatus = null;
  let parentRootJobId = null;
  if (resumeJobId) {
    try {
      parentStatus = loadJobOrThrow({ store, repoKey, jobId: resumeJobId, regenerate: false }).status;
    } catch (err) {
      if (err && err.exitCode === 3) err.message = `Parent job not found for --resume: ${resumeJobId}`;
      throw err;
    }
    parentRootJobId = parentStatus.root_job_id || resumeJobId;
  }

  const request = { model, canonicalDir: repoRoot, reasoningEffort, variant, effort, access };
  const inheritedGroup = group || (parentStatus ? parentStatus.group : null);
  const inheritedLabel = label || (parentStatus ? parentStatus.label : null);
  const inheritedAccess = access || (parentStatus ? parentStatus.access : null) || 'read-only';
  const executionToken = generateExecutionToken();

  const attempt = await openAttempt({
    store, adapter, request, prompt,
    repoKey, repoRoot, mode: 'submit', access: inheritedAccess,
    group: inheritedGroup, label: inheritedLabel, model,
    hardTimeoutSec, stateRoot,
    lineage: resumeJobId
      ? { parentJobId: resumeJobId, sessionStrategy: 'fork_from_artifacts', rootJobId: parentRootJobId || null }
      : null,
    // The detached worker owns the admission slot, and it journals the attempt
    // launch; openAttempt must neither acquire a slot nor journal for submit.
    admission: null,
    commandMode: 'run',
    hardTimeoutMs: hardTimeoutSec && hardTimeoutSec > 0 ? hardTimeoutSec * 1000 : 0,
    durableIdentity: { executionToken },
    journalLaunch: false,
  });
  const jobId = attempt.jobId;

  // Persist prompt and run params to the job directory for the worker
  const jobDir = store.getJobDir(repoKey, jobId);
  writeTextFileAtomic(path.join(jobDir, 'prompt.txt'), prompt);
  writeJsonFileAtomic(path.join(jobDir, 'params.json'), {
    canonicalDir: repoRoot,
    model,
    access: inheritedAccess,
    reasoningEffort: reasoningEffort || null,
    variant: variant || null,
    effort: effort || null,
    mode: 'run',
    hardTimeoutMs: hardTimeoutSec && hardTimeoutSec > 0 ? hardTimeoutSec * 1000 : 0,
    executionToken,
    // A fork of a parent session records that session as a fallback: when the
    // backend reports no session id, the worker's terminal detail carries the
    // parent's, so the fork is not provenance-less (ticket 92).
    ...(resumeJobId && parentStatus ? { fallbackSessionId: parentStatus.backend_session_id || null } : {}),
    _adapterScript: adapter.script || null,
  });

  // Spawn detached worker (admission slot acquired by the worker itself)
  await spawnWorker({
    store, stateRoot, backend: backend || attempt.backend, jobId, repoKey, repoRoot, hardTimeoutSec,
    executionToken,
  });

  return { jobId };
}

function spawnWorker({ store, stateRoot, backend, jobId, repoKey, repoRoot, hardTimeoutSec, executionToken }) {
  const workerScript = path.resolve(__dirname, 'worker.js');
  const workerLog = fs.openSync(path.join(stateRoot, 'jobs', repoKey, jobId, 'attempts', '1', 'worker.log'), 'a');
  const hardTimeoutMs = hardTimeoutSec && hardTimeoutSec > 0 ? hardTimeoutSec * 1000 : 0;

  let child;
  try {
    child = spawn(process.execPath, [workerScript], {
      detached: true,
      windowsHide: true,
      // The caller exits independently; redirect instead of creating an
      // undrained pipe, while keeping worker diagnostics durable.
      stdio: ['ignore', workerLog, workerLog],
      env: {
        ...process.env,
        DCLI_WORKER: '1',
        DCLI_STATE_ROOT: stateRoot,
        DCLI_BACKEND: backend,
        DCLI_JOB_ID: jobId,
        DCLI_REPO_KEY: repoKey,
        DCLI_REPO_ROOT: repoRoot,
        DCLI_WORKER_HARD_TIMEOUT_MS: String(hardTimeoutMs),
      },
    });
  } finally {
    fs.closeSync(workerLog);
  }

  try {
    store.recordWorkerLaunch({ jobId, repoKey, attempt: 1, from: 'created', pid: child.pid, executionToken });
  } catch (err) {
    try { child.kill(); } catch {}
    throw err;
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const journalSpawnFailure = (err) => {
      try {
        const { JobStore } = require('../job-store');
        const store = new JobStore({ stateRoot });
        store.journalTransition(jobId, repoKey, {
          kind: 'attempt_state_changed',
          attempt: 1,
          from: 'created',
          to: 'failed',
          detail: {
            finished_at: new Date().toISOString(),
            phase: 'terminal',
            failure_reason: 'worker_spawn_failed',
            failure: err.message,
          },
        });
      } catch {}
      settle();
    };
    const timer = setTimeout(settle, 1000);
    child.once('spawn', settle);
    child.once('error', journalSpawnFailure);
    // Allow parent to exit independently after the creation result is known.
    child.unref();
  });
}

module.exports = { executeSubmit };
