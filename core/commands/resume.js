const crypto = require('crypto');
const path = require('path');
const { DEFAULT_BACKEND } = require('../../adapters/registry');
const { generateJobId } = require('../job-id');
const { buildEnvelope, isVersionInRange, tryDisposeAdapter, classifyTerminalFailure } = require('./index');
const { reduce, TERMINAL } = require('../reducer');
const { resolveDeadline, resolveHardTimeoutMs } = require('../deadlines');
const { createDetachedWorktree, removeWorktree, finalizeSnapshot } = require('../worktree');
const { persistCollectedResult, persistInitFiles, persistBackendEvents, persistFindings } = require('../result-artifact');

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
  let detectedVersion;
  let manifest;
  try {
    adapter.ValidateRequest(request);

    detectedVersion = adapter.DetectVersion();
    manifest = adapter.ProbeCapabilities();
    if (manifest.supported_version_range) {
      if (!isVersionInRange(detectedVersion, manifest.supported_version_range)) {
        const range = manifest.supported_version_range;
        const err = new Error(
          `Backend version ${detectedVersion} is outside supported range ` +
          `${range.min || 'any'} - ${range.max || 'any'}. Cannot create job.`
        );
        err.code = 'VERSION_OUT_OF_RANGE';
        err.exitCode = 12;
        throw err;
      }
    }
  } catch (err) {
    if (worktreePath) removeWorktree(repoRoot, worktreePath);
    if (err.code === 'VALIDATION_FAILED') {
      err.exitCode = 2;
      throw err;
    }
    throw err;
  }

  const capabilitiesSnapshot = manifest;
  const identity = adapter.GetIdentity();
  const backend = identity.backend || DEFAULT_BACKEND;
  const backendVersion = detectedVersion || '1.0.0';
  const adapterVersion = identity.adapter_version || '1.0.0';

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

  function finalizeWorktreeSnapshot() {
    if (!worktreePath) return {};
    try {
      const { resultCommit } = finalizeSnapshot(worktreePath, resolveDeadline('SNAPSHOT_FINALIZE_MS'));
      return { worktree_result_commit: resultCommit || worktreeBaseCommit };
    } catch (err) {
      return { worktree_finalize_error: err.message };
    }
  }

  const attempt = {};

  const hardTimeoutMs = resolveHardTimeoutMs(hardTimeoutSec);
  let hardTimedOut = false;
  let hardTimeoutTimer = null;

  async function cancelThroughRungs() {
    try {
      const rungs = adapter.DeclareCancelRungs();
      if (rungs && rungs.length > 0) {
        for (const rung of rungs) {
          try { await adapter.RequestCancel(attempt, rung); } catch {}
        }
      }
    } catch {}
  }

  if (hardTimeoutMs > 0) {
    hardTimeoutTimer = setTimeout(async () => {
      if (hardTimedOut) return;
      hardTimedOut = true;
      await cancelThroughRungs();
    }, hardTimeoutMs);
    if (hardTimeoutTimer.unref) hardTimeoutTimer.unref();
  }

  try {
    adapter.PrepareInvocation(attempt, request);
    await adapter.Start(attempt);
    if (hardTimedOut) throw null;

    if (kind === 'continue_backend_session') {
      adapter.Resume(attempt, kind, prompt);
    }

    await adapter.SendPrompt(attempt, prompt);
    if (hardTimedOut) throw null;
  } catch (err) {
    clearTimeout(hardTimeoutTimer);
    if (hardTimedOut) {
      store.journalTransition(jobId, repoKey, {
        kind: 'attempt_state_changed',
        attempt: attemptNum,
        from: 'running',
        to: 'timed_out',
        detail: {
          finished_at: new Date().toISOString(),
          command_exit_code: null,
          phase: 'terminal',
          failure_reason: 'hard_timeout',
          ...finalizeWorktreeSnapshot(),
        },
      });
      await tryDisposeAdapter(adapter, attempt);
      if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
      const finalStatus = store.readStatus({ repoKey, jobId });
      return { text: '', jobId, envelope: buildEnvelope(finalStatus), exitCode: 24 };
    }
    await tryDisposeAdapter(adapter, attempt);
    if (worktreePath) removeWorktree(repoRoot, worktreePath);
    if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
    throw err;
  }

  const facts = [];
  try {
    for await (const fact of adapter.Observe(attempt)) {
      if (hardTimedOut) throw null;
      facts.push(fact);

      if (fact.type === 'process_exited') {
        const status = store.regenerateStatus({ repoKey, jobId });
        const result = reduce(status, facts, {});
        const collected = adapter.CollectResult(attempt);
        let backendSessionId = collected.backend_session_id;
        if (!backendSessionId && parentBackendSessionId) {
          backendSessionId = parentBackendSessionId;
        }

        const terminalState = result.state;
        let resultBytes;
        try {
          resultBytes = persistCollectedResult({ store, repoKey, jobId, attemptNum, collected });
        } catch {
          store.journalTransition(jobId, repoKey, {
            kind: 'attempt_state_changed',
            attempt: attemptNum,
            from: 'running',
            to: 'failed',
            detail: {
              finished_at: new Date().toISOString(),
              command_exit_code: fact.code !== undefined ? fact.code : null,
              phase: 'terminal',
              session_strategy: kind,
              failure_reason: 'result_persistence_failed',
              failure: { class: 'artifact_persistence', message: 'Unable to persist result artifact' },
              ...finalizeWorktreeSnapshot(),
            },
          });
          await tryDisposeAdapter(adapter, attempt);
          if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
          const finalStatus = store.readStatus({ repoKey, jobId });
          return { text: '', jobId, envelope: buildEnvelope(finalStatus), exitCode: 11 };
        }
        try { persistBackendEvents({ store, repoKey, jobId, attemptNum, facts }); } catch {}
        try { persistFindings({ store, repoKey, jobId, attemptNum, text: collected.text }); } catch {}

        const terminalFailure = classifyTerminalFailure({
          exitCode: fact.code !== undefined ? fact.code : null,
          resultBytes,
          reducerResult: result,
        });

        store.journalTransition(jobId, repoKey, {
          kind: 'attempt_state_changed',
          attempt: attemptNum,
          from: 'running',
          to: terminalState,
          detail: {
            finished_at: new Date().toISOString(),
            command_exit_code: fact.code !== undefined ? fact.code : null,
            phase: 'terminal',
            session_strategy: kind,
            failure_reason: terminalFailure.failure_reason,
            failure: terminalFailure.failure,
            ...(backendSessionId ? { backend_session_id: backendSessionId } : {}),
            ...(collected.usage ? { tokens: collected.usage } : {}),
            result_bytes: resultBytes,
            ...finalizeWorktreeSnapshot(),
          },
        });

        await tryDisposeAdapter(adapter, attempt);
        if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
        const finalStatus = store.readStatus({ repoKey, jobId });
        return { text: collected.text, jobId, envelope: buildEnvelope(finalStatus) };
      }
    }
  } catch (err) {
    clearTimeout(hardTimeoutTimer);
    if (hardTimedOut) {
      store.journalTransition(jobId, repoKey, {
        kind: 'attempt_state_changed',
        attempt: attemptNum,
        from: 'running',
        to: 'timed_out',
        detail: {
          finished_at: new Date().toISOString(),
          command_exit_code: null,
          phase: 'terminal',
          failure_reason: 'hard_timeout',
          ...finalizeWorktreeSnapshot(),
        },
      });
      await tryDisposeAdapter(adapter, attempt);
      if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
      const finalStatus = store.readStatus({ repoKey, jobId });
      return { text: '', jobId, envelope: buildEnvelope(finalStatus), exitCode: 24 };
    }
    if (worktreePath) removeWorktree(repoRoot, worktreePath);
    await tryDisposeAdapter(adapter, attempt);
    if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
    throw err;
  }

  clearTimeout(hardTimeoutTimer);

  if (hardTimedOut) {
    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed',
      attempt: attemptNum,
      from: 'running',
      to: 'timed_out',
      detail: {
        finished_at: new Date().toISOString(),
        command_exit_code: null,
        phase: 'terminal',
        failure_reason: 'hard_timeout',
        ...finalizeWorktreeSnapshot(),
      },
    });
    await tryDisposeAdapter(adapter, attempt);
    if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
    const finalStatus = store.readStatus({ repoKey, jobId });
    return { text: '', jobId, envelope: buildEnvelope(finalStatus), exitCode: 24 };
  }

  const collected = adapter.CollectResult(attempt);
  const status = store.regenerateStatus({ repoKey, jobId });
  const result = reduce(status, facts, {});
  let resultBytes = null;
  try { resultBytes = persistCollectedResult({ store, repoKey, jobId, attemptNum, collected }); } catch {}
  try { persistBackendEvents({ store, repoKey, jobId, attemptNum, facts }); } catch {}
  try { persistFindings({ store, repoKey, jobId, attemptNum, text: collected.text }); } catch {}

  let backendSessionId = collected.backend_session_id;
  if (!backendSessionId && parentBackendSessionId) {
    backendSessionId = parentBackendSessionId;
  }

  const terminalState = TERMINAL.has(result.state) ? result.state : 'interrupted';

  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed',
    attempt: attemptNum,
    from: 'running',
    to: terminalState,
    detail: {
      finished_at: new Date().toISOString(),
      command_exit_code: result.command_exit_code !== undefined ? result.command_exit_code : null,
      phase: 'terminal',
      session_strategy: kind,
      failure_reason: result.failure_reason || (terminalState === 'interrupted' ? 'observe_ended' : null),
      failure: result.failure || null,
      ...(backendSessionId ? { backend_session_id: backendSessionId } : {}),
      ...(collected.usage ? { tokens: collected.usage } : {}),
      result_bytes: resultBytes,
      ...finalizeWorktreeSnapshot(),
    },
  });

  await tryDisposeAdapter(adapter, attempt);
  if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
  const finalStatus = store.readStatus({ repoKey, jobId });
  return { text: collected.text, jobId, envelope: buildEnvelope(finalStatus), exitCode: terminalState === 'interrupted' ? 0 : 1 };
}

module.exports = { executeResume, VALID_KINDS };
