const crypto = require('crypto');
const path = require('path');
const { generateJobId } = require('../job-id');
const { runAttempt, prepareBackend } = require('./attempt');
const { resolveHardTimeoutMs } = require('../deadlines');
const { createDetachedWorktree, removeWorktree } = require('../worktree');
const { persistInitFiles } = require('../result-artifact');
const { workerIdentityDetail } = require('../process-identity');


async function executeRun({ store, adapter, repoKey, repoRoot, prompt, hardTimeoutSec, group, label, model, access, reasoningEffort, variant, effort, admission, mode, stateRoot }) {
  const jobId = generateJobId();
  const now = new Date();
  const isoNow = now.toISOString();
  let acquiredSlotId = null;
  const effectiveMode = mode === 'implement' ? 'implement' : 'run';

  let canonicalDir = repoRoot;
  let worktreePath = null;
  let worktreeBaseCommit = null;
  if (effectiveMode === 'implement') {
    if (!stateRoot) {
      const err = new Error('implement mode requires a state root');
      err.exitCode = 2;
      throw err;
    }
    worktreePath = path.join(stateRoot, 'worktrees', jobId);
    const wt = createDetachedWorktree(repoRoot, worktreePath, undefined, stateRoot);
    worktreeBaseCommit = wt.baseCommit;
    canonicalDir = worktreePath;
  }

  const request = { model, canonicalDir, reasoningEffort, variant, effort, access };
  let prepared;
  try {
    prepared = prepareBackend({ adapter, request });
  } catch (err) {
    if (worktreePath) removeWorktree(repoRoot, worktreePath);
    throw err;
  }
  const { manifest, backend, backendVersion, adapterVersion } = prepared;

  const capabilitiesSnapshot = manifest;
  if (admission) {
    const result = admission.acquireSlot(backend);
    if (!result.acquired) {
      if (worktreePath) removeWorktree(repoRoot, worktreePath);
      const err = new Error(`System at capacity (global: ${result.active}/${result.limit}). Try again later or use "submit" instead.`);
      err.exitCode = 14;
      throw err;
    }
    acquiredSlotId = result.slotId;
  }

  const effectiveAccess = access || 'read-only';

  store.createJob({
    jobId, repoKey, repoRoot,
    backend,
    backendVersion,
    adapterVersion,
    mode: effectiveMode,
    access: effectiveAccess,
    group, label, model,
    hardTimeoutSec,
    capabilitiesSnapshot,
  });

  const attemptNum = 1;
  store.createAttemptDir({ repoKey, jobId, attemptNum });
  persistInitFiles({
    store, repoKey, jobId, attemptNum, prompt,
    commandParams: {
      model,
      access: effectiveAccess,
      mode: effectiveMode,
      hardTimeoutMs: resolveHardTimeoutMs(hardTimeoutSec),
      reasoningEffort,
      variant,
      effort,
    },
  });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created',
    attempt: attemptNum,
    from: null,
    to: 'created',
    detail: { attempt_id: `attempt-${attemptNum}`, execution_token: 'tok-' + crypto.randomBytes(16).toString('hex') },
  });

  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed',
    attempt: attemptNum,
    from: 'created',
    to: 'running',
    detail: {
      started_at: isoNow,
      phase: 'agent_running',
      // A foreground run owns the job too: without its identity a Ctrl-C'd or
      // crashed `run` leaves the record `running` with nothing able to prove
      // otherwise.
      ...workerIdentityDetail({ durable: false }),
      ...(worktreePath ? { worktree_path: worktreePath, worktree_base_commit: worktreeBaseCommit } : {}),
    },
  });

  return runAttempt({
    store, adapter, repoKey, repoRoot, jobId, attemptNum, prompt, request,
    worktreePath, worktreeBaseCommit, hardTimeoutSec, admission, acquiredSlotId,
  });
}

module.exports = { executeRun };
