const crypto = require('crypto');
const path = require('path');
const { generateJobId } = require('../job-id');
const { prepareBackend, releaseSetupResources } = require('./attempt');
const { driveAttempt, createCancelSignal } = require('./attempt-driver');
const { resolveHardTimeoutMs } = require('../deadlines');
const { createDetachedWorktree } = require('../worktree');
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
  let worktreeCreated = false;
  if (effectiveMode === 'implement') {
    if (!stateRoot) {
      const err = new Error('implement mode requires a state root');
      err.exitCode = 2;
      throw err;
    }
    worktreePath = path.join(stateRoot, 'worktrees', jobId);
    const wt = createDetachedWorktree(repoRoot, worktreePath, undefined, stateRoot);
    worktreeCreated = true;
    worktreeBaseCommit = wt.baseCommit;
    canonicalDir = worktreePath;
  }

  const request = { model, canonicalDir, reasoningEffort, variant, effort, access };
  const effectiveAccess = access || 'read-only';

  // Setup ownership boundary: every resource acquired below (the worktree and
  // the admission slot) is either handed to runAttempt() below, or released by
  // this guard before rethrowing. A failure in createJob/createAttemptDir/
  // persistInitFiles used to exit without either, stranding the worktree and
  // burning the durable slot until reconciliation.
  try {
    const { manifest, backend, backendVersion, adapterVersion } = prepareBackend({ adapter, request });

    if (admission) {
      const result = admission.acquireSlot(backend);
      if (!result.acquired) {
        const err = new Error(`System at capacity (global: ${result.active}/${result.limit}). Try again later or use "submit" instead.`);
        err.exitCode = 14;
        throw err;
      }
      acquiredSlotId = result.slotId;
    }

    store.createJob({
      jobId, repoKey, repoRoot,
      backend,
      backendVersion,
      adapterVersion,
      mode: effectiveMode,
      access: effectiveAccess,
      group, label, model,
      hardTimeoutSec,
      capabilitiesSnapshot: manifest,
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
  } catch (err) {
    releaseSetupResources({ repoRoot, worktreePath, worktreeCreated, admission, acquiredSlotId });
    throw err;
  }

  return driveAttempt({
    store, adapter, repoKey, repoRoot, jobId, attemptNum: 1, prompt, request,
    worktreePath, worktreeBaseCommit, hardTimeoutSec, admission, acquiredSlotId,
    // A foreground run is cancellable like a worker: driveAttempt watches the
    // same `cancel.request` file `dcli cancel` writes.
    cancelSignal: createCancelSignal({ jobDir: store.getJobDir(repoKey, jobId) }),
  });
}

module.exports = { executeRun };
