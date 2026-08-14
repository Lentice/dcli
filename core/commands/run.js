const { openAttempt } = require('../job-setup');
const { driveAttempt, createCancelSignal } = require('./attempt-driver');

async function executeRun({ store, adapter, repoKey, repoRoot, prompt, hardTimeoutSec, group, label, model, access, variant, effort, admission, mode, stateRoot }) {
  const effectiveMode = mode === 'implement' ? 'implement' : 'run';
  const effectiveAccess = access || 'read-only';
  const request = { model, canonicalDir: repoRoot, variant, effort, access };

  const attempt = await openAttempt({
    store, adapter, request, prompt,
    repoKey, repoRoot, mode: effectiveMode, access: effectiveAccess,
    group, label, model, hardTimeoutSec, stateRoot,
    lineage: null,
    admission,
  });

  return driveAttempt({
    store, adapter, repoKey, repoRoot, jobId: attempt.jobId, attemptNum: attempt.attemptNum, prompt, request,
    worktreePath: attempt.worktree, worktreeBaseCommit: attempt.worktreeBaseCommit,
    hardTimeoutSec, admission, acquiredSlotId: attempt.acquiredSlotId,
    // A foreground run is cancellable like a worker: driveAttempt watches the
    // same `cancel.request` file `dcli cancel` writes.
    cancelSignal: createCancelSignal({ jobDir: store.getJobDir(repoKey, attempt.jobId) }),
  });
}

module.exports = { executeRun };
