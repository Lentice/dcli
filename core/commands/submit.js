const path = require('path');
const { loadJobOrThrow } = require('../job-lookup');
const { openAttempt } = require('../job-setup');
const { writeTextFileAtomic, writeJsonFileAtomic } = require('../fs-text');
const { generateExecutionToken } = require('../process-identity');
const { spawnWorker } = require('../worker-spawn');

async function executeSubmit({ store, adapter, repoKey, repoRoot, prompt, hardTimeoutSec, group, label, model, access, reasoningEffort, variant, effort, admission, resumeJobId, mode, stateRoot, backend }) {
  stateRoot = stateRoot || store.stateRoot;
  repoRoot = repoRoot || process.cwd();

  // The job record keeps 'submit' for run-mode submits (its historical value)
  // and records 'implement' only when a worktree is actually prepared, so the
  // status.mode field never lies about isolation.
  const effectiveMode = mode === 'implement' ? 'implement' : 'run';
  const jobMode = effectiveMode === 'implement' ? 'implement' : 'submit';

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
    repoKey, repoRoot, mode: jobMode, access: inheritedAccess,
    group: inheritedGroup, label: inheritedLabel, model,
    hardTimeoutSec, stateRoot,
    lineage: resumeJobId
      ? { parentJobId: resumeJobId, sessionStrategy: 'fork_from_artifacts', rootJobId: parentRootJobId || null }
      : null,
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
    reasoningEffort: reasoningEffort || null,
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
  await spawnWorker({
    store, stateRoot, backend: backend || attempt.backend, jobId, repoKey, repoRoot, hardTimeoutSec,
    executionToken, queueClaimPath: null,
  }).launched;

  return { jobId };
}

module.exports = { executeSubmit };
