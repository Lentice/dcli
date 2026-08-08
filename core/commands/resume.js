const crypto = require('crypto');
const path = require('path');
const { generateJobId } = require('../job-id');
const { runAttempt, prepareBackend, releaseSetupResources } = require('./attempt');
const { loadJobOrThrow } = require('./index');
const { resolveHardTimeoutMs } = require('../deadlines');
const { createDetachedWorktree } = require('../worktree');
const { persistInitFiles } = require('../result-artifact');
const { workerIdentityDetail } = require('../process-identity');

const VALID_KINDS = new Set(['continue_backend_session', 'fork_from_artifacts', 'retry_attempt']);

async function executeResume({ store, adapter, repoKey, repoRoot, prompt, kind, hardTimeoutSec, group, label, model, access, reasoningEffort, variant, effort, admission, mode, stateRoot, parentJobId }) {
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

  const jobId = generateJobId();
  const now = new Date();
  const isoNow = now.toISOString();
  let acquiredSlotId = null;
  const effectiveMode = mode === 'implement' ? 'implement' : 'run';
  const parentMode = parentStatus.mode || 'run';

  const inheritedMode = effectiveMode;
  const inheritedAccess = access || parentStatus.access || 'read-only';

  let canonicalDir = repoRoot;
  let worktreePath = null;
  let worktreeBaseCommit = null;
  let worktreeCreated = false;
  let parentSnapshotCommit = null;

  if (parentStatus.worktree && parentStatus.worktree.result_commit) {
    parentSnapshotCommit = parentStatus.worktree.result_commit;
  }

  if (inheritedMode === 'implement') {
    if (!stateRoot) {
      const err = new Error('implement mode requires a state root');
      err.exitCode = 2;
      throw err;
    }
    worktreePath = path.join(stateRoot, 'worktrees', jobId);
    const seedCommit = kind === 'fork_from_artifacts' && parentSnapshotCommit ? parentSnapshotCommit : undefined;
    const wt = createDetachedWorktree(repoRoot, worktreePath, undefined, stateRoot, seedCommit);
    worktreeCreated = true;
    worktreeBaseCommit = wt.baseCommit;
    canonicalDir = worktreePath;
  }

  // The session to continue must be on the request, because PrepareInvocation
  // is the last point before Start() and some backends fix their session at
  // process launch. Handing it to adapter.Resume() after Start() — which is
  // when onStarted runs — is too late for those, and the job then ran in a
  // brand new session while still reporting success: the continuation silently
  // had none of the parent's context. Adapters that cannot continue a session
  // ignore the field.
  const request = {
    model, canonicalDir, reasoningEffort, variant, effort, access: inheritedAccess,
    ...(kind === 'continue_backend_session' ? { resumeSessionId: parentBackendSessionId } : {}),
  };

  // Setup ownership boundary: same contract as run.js — the worktree and the
  // admission slot acquired below are either handed to runAttempt() or
  // released here before rethrowing. A failure in createJob/createAttemptDir/
  // persistInitFiles used to strand both.
  try {
    const { manifest, backend, backendVersion, adapterVersion } = prepareBackend({ adapter, request });

    if (admission) {
      const result = admission.acquireSlot(backend);
      if (!result.acquired) {
        const err = new Error(`System at capacity (global: ${result.active}/${result.limit}). Try again later.`);
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
      mode: inheritedMode,
      access: inheritedAccess,
      group, label, model,
      hardTimeoutSec,
      capabilitiesSnapshot: manifest,
      parentJobId,
      rootJobId: parentRootJobId,
      sessionStrategy: kind,
    });

    const attemptNum = 1;
    store.createAttemptDir({ repoKey, jobId, attemptNum });
    persistInitFiles({
      store, repoKey, jobId, attemptNum, prompt,
      commandParams: {
        model,
        access: inheritedAccess,
        mode: inheritedMode,
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
        session_strategy: kind,
        ...workerIdentityDetail({ durable: false }),
        ...(worktreePath ? { worktree_path: worktreePath, worktree_base_commit: worktreeBaseCommit } : {}),
      },
    });
  } catch (err) {
    releaseSetupResources({ repoRoot, worktreePath, worktreeCreated, admission, acquiredSlotId });
    throw err;
  }

  return runAttempt({
    store, adapter, repoKey, repoRoot, jobId, attemptNum: 1, prompt, request,
    worktreePath, worktreeBaseCommit, hardTimeoutSec, admission, acquiredSlotId,
    onStarted: kind === 'continue_backend_session'
      ? (attempt) => adapter.Resume(attempt, kind, prompt)
      : null,
    fallbackSessionId: parentBackendSessionId,
    extraDetail: { session_strategy: kind },
  });
}

module.exports = { executeResume, VALID_KINDS };
