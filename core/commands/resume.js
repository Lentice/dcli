const crypto = require('crypto');
const path = require('path');
const { generateJobId } = require('../job-id');
const { runAttempt, prepareBackend } = require('./attempt');
const { resolveHardTimeoutMs } = require('../deadlines');
const { createDetachedWorktree, removeWorktree } = require('../worktree');
const { persistInitFiles } = require('../result-artifact');

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

  let parentStatus;
  try {
    parentStatus = store.readStatus({ repoKey, jobId: parentJobId });
  } catch {
    const err = new Error(`Parent job not found: ${parentJobId}`);
    err.exitCode = 3;
    throw err;
  }
  if (!parentStatus) {
    const err = new Error(`Parent job not found: ${parentJobId}`);
    err.exitCode = 3;
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
    worktreeBaseCommit = wt.baseCommit;
    canonicalDir = worktreePath;
  }

  const request = { model, canonicalDir, reasoningEffort, variant, effort, access: inheritedAccess };
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
    capabilitiesSnapshot,
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
      ...(worktreePath ? { worktree_path: worktreePath, worktree_base_commit: worktreeBaseCommit } : {}),
    },
  });

  return runAttempt({
    store, adapter, repoKey, repoRoot, jobId, attemptNum, prompt, request,
    worktreePath, worktreeBaseCommit, hardTimeoutSec, admission, acquiredSlotId,
    onStarted: kind === 'continue_backend_session'
      ? (attempt) => adapter.Resume(attempt, kind, prompt)
      : null,
    fallbackSessionId: parentBackendSessionId,
    extraDetail: { session_strategy: kind },
  });
}

module.exports = { executeResume, VALID_KINDS };
