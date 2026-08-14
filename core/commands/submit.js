const path = require('path');
const { loadJobOrThrow } = require('../job-lookup');
const { openAttempt } = require('../job-setup');
const { writeTextFileAtomic, writeJsonFileAtomic } = require('../fs-text');
const { generateExecutionToken } = require('../process-identity');
const { spawnWorker, journalWorkerSpawnFailure } = require('../worker-spawn');

async function executeSubmit({ store, adapter, repoKey, repoRoot, prompt, hardTimeoutSec, group, label, model, access, variant, effort, admission, resumeJobId, mode, stateRoot, backend, kind }) {
  stateRoot = stateRoot || store.stateRoot;
  repoRoot = repoRoot || process.cwd();

  if (kind !== undefined && kind !== null) {
    const err = new Error('--kind applies to resume, not submit. Use resume <job-id> --kind <kind>.');
    err.exitCode = 2;
    throw err;
  }

  // The job record keeps 'submit' for run-mode submits (its historical value)
  // and records 'implement' only when a worktree is actually prepared, so the
  // status.mode field never lies about isolation.
  const effectiveMode = mode === 'implement' ? 'implement' : 'run';
  const jobMode = effectiveMode === 'implement' ? 'implement' : 'submit';

  let parentStatus = null;
  let parentRootJobId = null;
  let parentSnapshotCommit = null;
  if (resumeJobId) {
    try {
      parentStatus = loadJobOrThrow({ store, repoKey, jobId: resumeJobId, regenerate: false }).status;
    } catch (err) {
      if (err && err.exitCode === 3) err.message = `Parent job not found for --resume: ${resumeJobId}`;
      throw err;
    }
    parentRootJobId = parentStatus.root_job_id || resumeJobId;
    if (effectiveMode === 'implement' && parentStatus.worktree && parentStatus.worktree.result_commit) {
      parentSnapshotCommit = parentStatus.worktree.result_commit;
    }
  }

  const request = { model, canonicalDir: repoRoot, variant, effort, access };
  const inheritedGroup = group || (parentStatus ? parentStatus.group : null);
  const inheritedLabel = label || (parentStatus ? parentStatus.label : null);
  const inheritedAccess = access || (parentStatus ? parentStatus.access : null) || 'read-only';
  const executionToken = generateExecutionToken();

  const attempt = await openAttempt({
    store, adapter, request, prompt,
    repoKey, repoRoot, mode: jobMode, access: inheritedAccess,
    group: inheritedGroup, label: inheritedLabel, model,
    hardTimeoutSec, stateRoot,
    lineage: resumeJobId
      ? { parentJobId: resumeJobId, sessionStrategy: 'fork_from_artifacts', rootJobId: parentRootJobId || null }
      : null,
    seedCommit: effectiveMode === 'implement' && parentSnapshotCommit ? parentSnapshotCommit : null,
    // The detached worker owns the admission slot, and it journals the attempt
    // launch; openAttempt must neither acquire a slot nor journal for submit.
    admission: null,
    commandMode: effectiveMode,
    hardTimeoutMs: hardTimeoutSec && hardTimeoutSec > 0 ? hardTimeoutSec * 1000 : 0,
    durableIdentity: { executionToken },
    journalLaunch: false,
  });
  const jobId = attempt.jobId;

  // Persist prompt and run params to the job directory for the worker. The
  // worker drives the attempt from these: mode decides run-vs-implement and
  // the worktree fields make the detached process finalize the snapshot the
  // way the foreground run path does.
  const jobDir = store.getJobDir(repoKey, jobId);
  writeTextFileAtomic(path.join(jobDir, 'prompt.txt'), prompt);
  writeJsonFileAtomic(path.join(jobDir, 'params.json'), {
    canonicalDir: attempt.worktree || repoRoot,
    model,
    access: inheritedAccess,
    variant: variant || null,
    effort: effort || null,
    mode: effectiveMode,
    worktreePath: attempt.worktree || null,
    worktreeBaseCommit: attempt.worktreeBaseCommit || null,
    hardTimeoutMs: hardTimeoutSec && hardTimeoutSec > 0 ? hardTimeoutSec * 1000 : 0,
    executionToken,
    // A fork of a parent session records that session as a fallback: when the
    // backend reports no session id, the worker's terminal detail carries the
    // parent's, so the fork is not provenance-less (ticket 92).
    ...(resumeJobId && parentStatus ? { fallbackSessionId: parentStatus.backend_session_id || null } : {}),
    _adapterScript: adapter.script || null,
  });

  // Spawn detached worker (admission slot acquired by the worker itself).
  // The initial submit has no queue claim; core/worker-spawn.js owns the
  // spawn and the launch-identity persistence.
  try {
    await spawnWorker({
      store, stateRoot, backend: backend || attempt.backend, jobId, repoKey, repoRoot, hardTimeoutSec,
      executionToken, queueClaimPath: null,
    }).launched;
  } catch (err) {
    journalWorkerSpawnFailure({ store, stateRoot, repoRoot, repoKey, jobId, error: err });
    attempt.release();
    throw err;
  }

  return { jobId };
}

module.exports = { executeSubmit };
