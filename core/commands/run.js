const crypto = require('crypto');
const path = require('path');
const { generateJobId } = require('../job-id');
const { reduce } = require('../reducer');
const { buildEnvelope, isVersionInRange, tryDisposeAdapter } = require('./index');
const { validateTimeoutMs, resolveDeadline } = require('../deadlines');
const { createDetachedWorktree, removeWorktree, finalizeSnapshot } = require('../worktree');
const { persistCollectedResult, persistInitFiles, persistBackendEvents, persistFindings } = require('../result-artifact');

const TERMINAL = new Set(['done', 'failed', 'timed_out', 'cancelled', 'interrupted']);

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
  const backend = identity.backend || 'fake';
  const backendVersion = detectedVersion || '1.0.0';
  const adapterVersion = identity.adapter_version || '1.0.0';
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
      hardTimeoutMs: hardTimeoutSec !== undefined && hardTimeoutSec !== null && hardTimeoutSec > 0 ? hardTimeoutSec * 1000 : 0,
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
    detail: worktreePath
      ? { started_at: isoNow, phase: 'agent_running', worktree_path: worktreePath, worktree_base_commit: worktreeBaseCommit }
      : { started_at: isoNow, phase: 'agent_running' },
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

  const hardTimeoutMs = hardTimeoutSec !== undefined && hardTimeoutSec !== null && hardTimeoutSec > 0
    ? hardTimeoutSec * 1000
    : 0;
  let hardTimedOut = false;
  let hardTimeoutTimer = null;

  function cancelThroughRungs() {
    try {
      const rungs = adapter.DeclareCancelRungs();
      if (rungs && rungs.length > 0) {
        for (const rung of rungs) {
          try { adapter.RequestCancel(attempt, rung); } catch {}
        }
      }
    } catch {}
  }

  if (hardTimeoutMs > 0) {
    hardTimeoutTimer = setTimeout(() => {
      if (hardTimedOut) return;
      hardTimedOut = true;
      cancelThroughRungs();
    }, hardTimeoutMs);
    if (hardTimeoutTimer.unref) hardTimeoutTimer.unref();
  }

  try {
    adapter.PrepareInvocation(attempt, request);
    await adapter.Start(attempt);
    if (hardTimedOut) throw null;
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
      tryDisposeAdapter(adapter, attempt);
      if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
      const finalStatus = store.readStatus({ repoKey, jobId });
      return { text: '', jobId, envelope: buildEnvelope(finalStatus), exitCode: 24 };
    }
    tryDisposeAdapter(adapter, attempt);
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
              failure_reason: 'result_persistence_failed',
              failure: { class: 'artifact_persistence', message: 'Unable to persist result artifact' },
              ...finalizeWorktreeSnapshot(),
            },
          });
          tryDisposeAdapter(adapter, attempt);
          if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
          const finalStatus = store.readStatus({ repoKey, jobId });
          return { text: '', jobId, envelope: buildEnvelope(finalStatus), exitCode: 11 };
        }
        try { persistBackendEvents({ store, repoKey, jobId, attemptNum, facts }); } catch {}
        try { persistFindings({ store, repoKey, jobId, attemptNum, text: collected.text }); } catch {}

        store.journalTransition(jobId, repoKey, {
          kind: 'attempt_state_changed',
          attempt: attemptNum,
          from: 'running',
          to: terminalState,
          detail: {
            finished_at: new Date().toISOString(),
            command_exit_code: fact.code !== undefined ? fact.code : null,
            phase: 'terminal',
            ...(collected.backend_session_id ? { backend_session_id: collected.backend_session_id } : {}),
            ...(collected.usage ? { tokens: collected.usage } : {}),
            result_bytes: resultBytes,
            ...finalizeWorktreeSnapshot(),
          },
        });

        tryDisposeAdapter(adapter, attempt);
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
      tryDisposeAdapter(adapter, attempt);
      if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
      const finalStatus = store.readStatus({ repoKey, jobId });
      return { text: '', jobId, envelope: buildEnvelope(finalStatus), exitCode: 24 };
    }
    tryDisposeAdapter(adapter, attempt);
    if (worktreePath) removeWorktree(repoRoot, worktreePath);
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
    tryDisposeAdapter(adapter, attempt);
    if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
    const finalStatus = store.readStatus({ repoKey, jobId });
    return { text: '', jobId, envelope: buildEnvelope(finalStatus), exitCode: 24 };
  }

  const collected = adapter.CollectResult(attempt);
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed',
    attempt: attemptNum,
    from: 'running',
    to: 'failed',
    detail: {
      finished_at: new Date().toISOString(),
      command_exit_code: 1,
      phase: 'terminal',
      ...finalizeWorktreeSnapshot(),
    },
  });

  tryDisposeAdapter(adapter, attempt);
  if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
  const finalStatus = store.readStatus({ repoKey, jobId });
  return { text: collected.text, jobId, envelope: buildEnvelope(finalStatus), exitCode: 1 };
}

module.exports = { executeRun };
