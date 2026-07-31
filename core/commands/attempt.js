const { buildEnvelope, tryDisposeAdapter, classifyTerminalFailure, isVersionInRange } = require('./index');
const { DEFAULT_BACKEND } = require('../../adapters/registry');
const { reduce, TERMINAL } = require('../reducer');
const { resolveDeadline, resolveHardTimeoutMs } = require('../deadlines');
const { finalizeSnapshot, removeWorktree } = require('../worktree');
const { persistCollectedResult, persistBackendEvents, persistFindings } = require('../result-artifact');

/**
 * Validate the request against the backend, check its version against the
 * capability manifest, and resolve the identity fields every job record
 * needs. run, resume and submit all did this identically before creating a
 * job; a backend that fails the check must never leave a job behind.
 *
 * @param {{ adapter:Object, request:Object }} args
 * @returns {{ manifest:Object, detectedVersion:string, backend:string,
 *             backendVersion:string, adapterVersion:string }}
 */
function prepareBackend({ adapter, request }) {
  try {
    adapter.ValidateRequest(request);
  } catch (err) {
    if (err.code === 'VALIDATION_FAILED') err.exitCode = 2;
    throw err;
  }

  const detectedVersion = adapter.DetectVersion();
  const manifest = adapter.ProbeCapabilities();
  const range = manifest.supported_version_range;
  if (range && !isVersionInRange(detectedVersion, range)) {
    const err = new Error(
      `Backend version ${detectedVersion} is outside supported range ` +
      `${range.min || 'any'} - ${range.max || 'any'}. Cannot create job.`
    );
    err.code = 'VERSION_OUT_OF_RANGE';
    err.exitCode = 12;
    throw err;
  }

  const identity = adapter.GetIdentity();
  return {
    manifest,
    detectedVersion,
    backend: identity.backend || DEFAULT_BACKEND,
    backendVersion: detectedVersion || '1.0.0',
    adapterVersion: identity.adapter_version || '1.0.0',
  };
}

/**
 * Drive one attempt of an already-created job to a terminal journal entry.
 *
 * `run` and `resume` had this whole body twice, character for character apart
 * from resume's Resume() call, its parent-session fallback, and a
 * `session_strategy` field. Those three are the parameters below; everything
 * else — the hard-timeout rung walk, the Observe loop, result persistence,
 * the terminal transition, dispose and slot release — is shared, so a fix to
 * the timeout or teardown path cannot land in one command and miss the other.
 *
 * The engine decides state here; the adapter only emits facts.
 *
 * @param {Object}   a
 * @param {Object}   a.store
 * @param {Object}   a.adapter
 * @param {string}   a.repoKey
 * @param {string}   a.repoRoot
 * @param {string}   a.jobId
 * @param {number}   a.attemptNum
 * @param {string}   a.prompt
 * @param {Object}   a.request            PrepareInvocation payload
 * @param {string|null} [a.worktreePath]  implement-mode worktree, if any
 * @param {string|null} [a.worktreeBaseCommit]
 * @param {number|null} [a.hardTimeoutSec]
 * @param {Object|null} [a.admission]
 * @param {string|null} [a.acquiredSlotId]
 * @param {function(Object):void} [a.onStarted]   runs after Start(), before SendPrompt()
 * @param {string|null} [a.fallbackSessionId]     used when the backend reports none
 * @param {Object}   [a.extraDetail]      merged into every terminal journal detail
 * @returns {Promise<{ text:string, jobId:string, envelope:Object, exitCode?:number }>}
 */
async function runAttempt({
  store, adapter, repoKey, repoRoot, jobId, attemptNum, prompt, request,
  worktreePath = null, worktreeBaseCommit = null, hardTimeoutSec = null,
  admission = null, acquiredSlotId = null,
  onStarted = null, fallbackSessionId = null, extraDetail = {},
}) {
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

  const releaseSlot = () => {
    if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
  };

  async function finishTimedOut() {
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
    releaseSlot();
    const finalStatus = store.readStatus({ repoKey, jobId });
    return { text: '', jobId, envelope: buildEnvelope(finalStatus), exitCode: 24 };
  }

  // Teardown for a genuine error: dispose the adapter (killing the child)
  // BEFORE removing the worktree it was running inside.
  async function abandon(err) {
    await tryDisposeAdapter(adapter, attempt);
    if (worktreePath) removeWorktree(repoRoot, worktreePath);
    releaseSlot();
    throw err;
  }

  try {
    adapter.PrepareInvocation(attempt, request);
    await adapter.Start(attempt);
    if (hardTimedOut) throw null;
    if (onStarted) onStarted(attempt);
    await adapter.SendPrompt(attempt, prompt);
    if (hardTimedOut) throw null;
  } catch (err) {
    clearTimeout(hardTimeoutTimer);
    if (hardTimedOut) return finishTimedOut();
    return abandon(err);
  }

  const resolveSessionId = (collected) => collected.backend_session_id || fallbackSessionId || null;

  const facts = [];
  try {
    for await (const fact of adapter.Observe(attempt)) {
      if (hardTimedOut) throw null;
      facts.push(fact);

      if (fact.type === 'process_exited') {
        const status = store.regenerateStatus({ repoKey, jobId });
        const result = reduce(status, facts, {});
        const collected = adapter.CollectResult(attempt);
        const backendSessionId = resolveSessionId(collected);
        const terminalState = result.state;
        const exitCode = fact.code !== undefined ? fact.code : null;
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
              command_exit_code: exitCode,
              phase: 'terminal',
              ...extraDetail,
              failure_reason: 'result_persistence_failed',
              failure: { class: 'artifact_persistence', message: 'Unable to persist result artifact' },
              ...finalizeWorktreeSnapshot(),
            },
          });
          await tryDisposeAdapter(adapter, attempt);
          releaseSlot();
          const finalStatus = store.readStatus({ repoKey, jobId });
          return { text: '', jobId, envelope: buildEnvelope(finalStatus), exitCode: 11 };
        }
        try { persistBackendEvents({ store, repoKey, jobId, attemptNum, facts }); } catch {}
        try { persistFindings({ store, repoKey, jobId, attemptNum, text: collected.text }); } catch {}

        const terminalFailure = classifyTerminalFailure({ exitCode, resultBytes, reducerResult: result });

        store.journalTransition(jobId, repoKey, {
          kind: 'attempt_state_changed',
          attempt: attemptNum,
          from: 'running',
          to: terminalState,
          detail: {
            finished_at: new Date().toISOString(),
            command_exit_code: exitCode,
            phase: 'terminal',
            ...extraDetail,
            failure_reason: terminalFailure.failure_reason,
            failure: terminalFailure.failure,
            ...(backendSessionId ? { backend_session_id: backendSessionId } : {}),
            ...(collected.usage ? { tokens: collected.usage } : {}),
            result_bytes: resultBytes,
            ...finalizeWorktreeSnapshot(),
          },
        });

        await tryDisposeAdapter(adapter, attempt);
        releaseSlot();
        const finalStatus = store.readStatus({ repoKey, jobId });
        // The exit code follows the reduced terminal state, not the child's.
        // Omitting it defaulted the command to 0, which was indistinguishable
        // from success as soon as a backend could exit 0 on a failed turn —
        // an agent parsing the exit code read a provider refusal as a result.
        return {
          text: collected.text, jobId, envelope: buildEnvelope(finalStatus),
          exitCode: (terminalState === 'done' || terminalState === 'interrupted') ? 0 : 1,
        };
      }
    }
  } catch (err) {
    clearTimeout(hardTimeoutTimer);
    if (hardTimedOut) return finishTimedOut();
    return abandon(err);
  }

  clearTimeout(hardTimeoutTimer);

  if (hardTimedOut) return finishTimedOut();

  // Observe ended without a process_exited fact.
  const collected = adapter.CollectResult(attempt);
  const status = store.regenerateStatus({ repoKey, jobId });
  const result = reduce(status, facts, {});
  const backendSessionId = resolveSessionId(collected);
  let resultBytes = null;
  try { resultBytes = persistCollectedResult({ store, repoKey, jobId, attemptNum, collected }); } catch {}
  try { persistBackendEvents({ store, repoKey, jobId, attemptNum, facts }); } catch {}
  try { persistFindings({ store, repoKey, jobId, attemptNum, text: collected.text }); } catch {}

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
      ...extraDetail,
      failure_reason: result.failure_reason || (terminalState === 'interrupted' ? 'observe_ended' : null),
      failure: result.failure || null,
      ...(backendSessionId ? { backend_session_id: backendSessionId } : {}),
      ...(collected.usage ? { tokens: collected.usage } : {}),
      result_bytes: resultBytes,
      ...finalizeWorktreeSnapshot(),
    },
  });

  await tryDisposeAdapter(adapter, attempt);
  releaseSlot();
  const finalStatus = store.readStatus({ repoKey, jobId });
  return {
    text: collected.text,
    jobId,
    envelope: buildEnvelope(finalStatus),
    exitCode: terminalState === 'interrupted' ? 0 : 1,
  };
}

module.exports = { runAttempt, prepareBackend };
