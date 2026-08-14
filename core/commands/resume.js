const { openAttempt } = require('../job-setup');
const { driveAttempt, createCancelSignal } = require('./attempt-driver');
const { loadJobOrThrow } = require('../job-lookup');

const VALID_KINDS = new Set(['continue_backend_session', 'fork_from_artifacts', 'retry_attempt']);

async function executeResume({ store, adapter, repoKey, repoRoot, prompt, kind, hardTimeoutSec, group, label, model, access, variant, effort, admission, mode, stateRoot, parentJobId }) {
  if (!kind) {
    const err = new Error('--kind is required (continue_backend_session, fork_from_artifacts, or retry_attempt)');
    err.exitCode = 2;
    throw err;
  }

  if (!parentJobId) {
    const err = new Error('resume requires a parent job ID as positional argument');
    err.exitCode = 2;
    throw err;
  }

  // Existence is the job directory's, per the exit-3 contract, and a record
  // that exists but cannot be read is exit 17 — not a claim that the parent
  // does not exist. The shared read-side loader is the single place that rule
  // lives; resume, submit --resume, diff and apply each had their own
  // catch-all before this.
  let parentStatus;
  try {
    parentStatus = loadJobOrThrow({ store, repoKey, jobId: parentJobId, regenerate: false }).status;
  } catch (err) {
    if (err && err.exitCode === 3) err.message = `Parent job not found: ${parentJobId}`;
    throw err;
  }

  const parentBackendSessionId = parentStatus.backend_session_id;
  const parentRootJobId = parentStatus.root_job_id || parentJobId;

  if (kind === 'continue_backend_session') {
    if (parentStatus.state === 'interrupted') {
      const err = new Error(`Parent job ${parentJobId} is interrupted. An interrupted attempt does not support continue_backend_session. Use --kind retry_attempt or fork_from_artifacts instead.`);
      err.exitCode = 22;
      throw err;
    }

    if (!parentBackendSessionId) {
      const err = new Error(`Parent job ${parentJobId} has no backend session id to continue. Use --kind fork_from_artifacts or retry_attempt instead.`);
      err.exitCode = 22;
      throw err;
    }

    const caps = adapter.ProbeCapabilities();
    const canContinue = caps.core && caps.core.resume;
    if (!canContinue) {
      const err = new Error(`Backend ${adapter.GetIdentity().backend} does not support continue_backend_session. Use --kind fork_from_artifacts or retry_attempt instead.`);
      err.exitCode = 22;
      throw err;
    }
  }

  const effectiveMode = mode === 'implement' ? 'implement' : 'run';
  const parentMode = parentStatus.mode || 'run';

  const inheritedMode = effectiveMode;
  const inheritedAccess = access || parentStatus.access || 'read-only';

  let parentSnapshotCommit = null;
  if (parentStatus.worktree && parentStatus.worktree.result_commit) {
    parentSnapshotCommit = parentStatus.worktree.result_commit;
  }

  // The session to continue must be on the request, because PrepareInvocation
  // is the last point before Start() and some backends fix their session at
  // process launch. Handing it to adapter.Resume() after Start() — which is
  // when onStarted runs — is too late for those, and the job then ran in a
  // brand new session while still reporting success: the continuation silently
  // had none of the parent's context. Adapters that cannot continue a session
  // ignore the field.
  const request = {
    model, canonicalDir: repoRoot, variant, effort, access: inheritedAccess,
    ...(kind === 'continue_backend_session' ? { resumeSessionId: parentBackendSessionId } : {}),
  };

  const attempt = await openAttempt({
    store, adapter, request, prompt,
    repoKey, repoRoot, mode: inheritedMode, access: inheritedAccess,
    group, label, model, hardTimeoutSec, stateRoot,
    lineage: { parentJobId, sessionStrategy: kind, rootJobId: parentRootJobId },
    seedCommit: kind === 'fork_from_artifacts' && parentSnapshotCommit ? parentSnapshotCommit : null,
    admission,
  });

  return driveAttempt({
    store, adapter, repoKey, repoRoot, jobId: attempt.jobId, attemptNum: attempt.attemptNum, prompt, request,
    worktreePath: attempt.worktree, worktreeBaseCommit: attempt.worktreeBaseCommit,
    hardTimeoutSec, admission, acquiredSlotId: attempt.acquiredSlotId,
    onStarted: kind === 'continue_backend_session'
      ? (a) => adapter.Resume(a, kind, prompt)
      : null,
    fallbackSessionId: parentBackendSessionId,
    extraDetail: { session_strategy: kind },
    // A foreground resume is cancellable like a worker: driveAttempt watches
    // the same `cancel.request` file `dcli cancel` writes.
    cancelSignal: createCancelSignal({ jobDir: store.getJobDir(repoKey, attempt.jobId) }),
  });
}

module.exports = { executeResume, VALID_KINDS };
