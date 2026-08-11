// One attempt driver for the foreground and the detached worker.
//
// `run`/`resume` (foreground) and the submit worker used to carry two copies
// of this algorithm, and those copies had already drifted into four observable
// differences: worktree snapshot finalize, `fallbackSessionId`, the
// `cancel.request` watcher, and `kill_skipped` on hard timeout. Both paths now
// call `driveAttempt`; the remaining differences are parameters, not code.
//
// This module owns, once: the hard-timeout rung walk, the bounded Observe
// loop, `persistStartedFact`, the `process_exited` branch, result/events/
// findings persistence with its ordering, the `result_persistence_failed`
// path, `classifyTerminalFailure`, the terminal `journalTransition`,
// `tryDisposeAdapter`, admission slot release, and `terminalExitCode`.
//
// The engine decides state here; the adapter only emits facts (invariant 2).
// No backend name may appear in this module (invariant 1).
const fs = require('fs');
const path = require('path');
const { buildEnvelope } = require('../envelope');
const { classifyTerminalFailure, terminalExitCode } = require('../failure-class');
const { reduce, TERMINAL } = require('../reducer');
const { resolveDeadline, resolveHardTimeoutMs } = require('../deadlines');
const { finalizeSnapshot, removeWorktree } = require('../worktree');
const { persistCollectedResult, persistBackendEvents, persistFindings } = require('../result-artifact');

const CANCEL_WATCH_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 5000;

async function tryDisposeAdapter(adapter, attempt) {
  if (!adapter || typeof adapter.Dispose !== 'function') return { disposed: false, reason: 'no_adapter' };
  const ms = resolveDeadline('ADAPTER_DISPOSE_MS');
  try {
    const disposeWork = adapter.Dispose(attempt);
    let timer;
    let completed;
    try {
      completed = await Promise.race([
        (async () => { await disposeWork; return true; })(),
        new Promise(resolve => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return { disposed: true, exceeded: !completed };
  } catch (err) {
    return { disposed: false, reason: err.message || 'dispose_error' };
  }
}

/**
 * A cancel signal the attempt driver can poll without knowing where it came
 * from. The worker and the foreground both pass one backed by the shared
 * `cancel.request` poller, so `dcli cancel` reaches both paths; tests inject a
 * plain object implementing the same two methods.
 *
 * @typedef {Object} CancelSignal
 * @property {function():boolean} isCancelled
 * @property {function():void} [dispose]
 */

/**
 * Drive one attempt of an already-created job to a terminal journal entry.
 *
 * The caller (run.js / resume.js / worker.js) has already created the job,
 * journaled `attempt_created` and the `running` transition with its launch
 * identity, and acquired the admission slot. This function owns everything
 * after that handoff and returns the derived terminal state plus the CLI exit
 * code that follows it.
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
 * @param {CancelSignal|null} [a.cancelSignal]    polled for `cancel.request`
 * @returns {Promise<{ text:string, jobId:string, envelope:Object, exitCode:number,
 *                      terminalState:string|null }>}
 */
async function driveAttempt({
  store, adapter, repoKey, repoRoot, jobId, attemptNum, prompt, request,
  worktreePath = null, worktreeBaseCommit = null, hardTimeoutSec = null,
  admission = null, acquiredSlotId = null,
  onStarted = null, fallbackSessionId = null, extraDetail = {},
  cancelSignal = null,
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
  const hardDeadline = hardTimeoutMs > 0 ? Date.now() + hardTimeoutMs : null;
  let hardTimedOut = false;
  let hardTimeoutTimer = null;
  // Why hard-timeout escalation records what it records, per platform. Windows
  // without a tree-kill rung result: the adapters spawn the backend with a
  // plain `spawn` (no Job Object), so no tree is inside a Job Object, and the
  // native helper can only terminate a Job Object it created itself. Recording
  // `kill_skipped` — not a kill we did not perform — is AGENTS.md lessons #5.
  // Unix: the hard_kill rung terminates the whole process group (ADR-010 rung
  // 1), so the kill was performed and no `kill_skipped` is written. Windows
  // with a taskkill-tree result (ADR-010 rung 2, ticket 103): a kill was
  // attempted too, so `kill_skipped` is replaced by the survivors the
  // verification step found — writing "skipped" after a real attempt is the
  // inverse lie.
  const hardTimeoutKillSkipped = process.platform === 'win32' ? 'not_contained' : undefined;
  // The taskkill-tree result captured when the hard-timeout timer itself fires
  // (the first cancelThroughRungs for that deadline). finishTimedOut re-runs
  // the rung walk, but the adapter short-circuits a second cancellation, so
  // this is where the real result survives.
  let hardTimeoutTermination = null;

  async function cancelThroughRungs() {
    let termination = null;
    try {
      const rungs = adapter.DeclareCancelRungs();
      if (rungs && rungs.length > 0) {
        for (const rung of rungs) {
          try {
            const res = await adapter.RequestCancel(attempt, rung);
            if (res && res.termination) termination = res.termination;
          } catch {}
        }
      }
    } catch {}
    return termination;
  }

  if (hardTimeoutMs > 0) {
    hardTimeoutTimer = setTimeout(async () => {
      if (hardTimedOut) return;
      hardTimedOut = true;
      hardTimeoutTermination = await cancelThroughRungs();
    }, hardTimeoutMs);
    if (hardTimeoutTimer.unref) hardTimeoutTimer.unref();
  }

  // Cancel request watcher — the foreground gains what the worker had. The
  // injected cancelSignal is polled on a bounded cadence so a `cancel.request`
  // is acted on even while iter.next() is pending inside a hanging Observe;
  // that is exactly when the adapter-side rung walk is needed to break it.
  let cancelled = false;
  let cancelWatcherTimer = null;
  async function checkCancelRequest() {
    if (cancelled || hardTimedOut) return;
    let requested = false;
    try {
      requested = !!(cancelSignal && typeof cancelSignal.isCancelled === 'function' && cancelSignal.isCancelled());
    } catch {}
    if (requested) {
      cancelled = true;
      clearTimeout(cancelWatcherTimer);
      await cancelThroughRungs();
      return;
    }
    cancelWatcherTimer = setTimeout(checkCancelRequest, CANCEL_WATCH_MS);
    if (cancelWatcherTimer.unref) cancelWatcherTimer.unref();
  }
  if (cancelSignal) {
    cancelWatcherTimer = setTimeout(checkCancelRequest, CANCEL_WATCH_MS);
    if (cancelWatcherTimer.unref) cancelWatcherTimer.unref();
  }

  // Heartbeat on a cadence, not once. The reducer treats a heartbeat older
  // than 15s as evidence the owner is gone, so a foreground run must publish
  // on the same cadence as a worker, or a Ctrl-C'd `run` sits `running` until
  // reconciliation notices the stale heartbeat.
  const heartbeatTimer = setInterval(() => {
    try { store.writeHeartbeat({ repoKey, jobId }); } catch {}
  }, HEARTBEAT_INTERVAL_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  const facts = [];

  // Every terminal exit routes through here so no timer, watcher, slot or
  // cancel signal outlives the attempt on any path.
  const releaseSlot = () => {
    clearInterval(heartbeatTimer);
    clearTimeout(hardTimeoutTimer);
    clearTimeout(cancelWatcherTimer);
    if (cancelSignal && typeof cancelSignal.dispose === 'function') cancelSignal.dispose();
    if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
  };

  async function finishTimedOut() {
    const termination = (await cancelThroughRungs()) || hardTimeoutTermination;
    // A taskkill-tree result is recognised by its survivors array. When such a
    // rung ran, the timed_out detail records what it verified and does NOT
    // write `kill_skipped` — a kill was attempted, and claiming a skipped kill
    // after one is the same dishonesty as claiming one that did not happen.
    // `kill_skipped` stays correct only when no kill was attempted.
    const treeKill = termination && Array.isArray(termination.survivors) ? termination : null;
    // Flush whatever partial output the adapter still has before the terminal
    // journal (worker behaviour; the foreground gains it).
    let partialResult = null;
    try { partialResult = adapter.CollectResult(attempt); } catch {}
    if (partialResult && partialResult.text) {
      try { persistCollectedResult({ store, repoKey, jobId, attemptNum, collected: partialResult }); } catch {}
      try { persistFindings({ store, repoKey, jobId, attemptNum, text: partialResult.text }); } catch {}
    }
    try { persistBackendEvents({ store, repoKey, jobId, attemptNum, facts }); } catch {}
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
        ...(treeKill
          ? {
              containment: { kind: treeKill.kind, degraded: treeKill.degraded !== false },
              containment_survivors: treeKill.survivors.map(survivorToRecord),
            }
          : { kill_skipped: hardTimeoutKillSkipped }),
        ...finalizeWorktreeSnapshot(),
      },
    });
    await tryDisposeAdapter(adapter, attempt);
    releaseSlot();
    const finalStatus = store.readStatus({ repoKey, jobId });
    return { text: '', jobId, envelope: buildEnvelope(finalStatus), exitCode: 24, terminalState: 'timed_out' };
  }

  async function finishCancelled() {
    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed',
      attempt: attemptNum,
      from: 'running',
      to: 'cancelled',
      detail: {
        finished_at: new Date().toISOString(),
        command_exit_code: null,
        phase: 'terminal',
      },
    });
    await tryDisposeAdapter(adapter, attempt);
    releaseSlot();
    const finalStatus = store.readStatus({ repoKey, jobId });
    return { text: '', jobId, envelope: buildEnvelope(finalStatus), exitCode: 0, terminalState: 'cancelled' };
  }

  // Teardown for a genuine error: dispose the adapter (killing the child)
  // BEFORE removing the worktree it was running inside.
  async function abandon(err) {
    await tryDisposeAdapter(adapter, attempt);
    if (worktreePath) removeWorktree(repoRoot, worktreePath);
    releaseSlot();
    try {
      const status = store.readStatus({ repoKey, jobId });
      if (!TERMINAL.has(status.state)) {
        store.journalTransition(jobId, repoKey, {
          kind: 'attempt_state_changed',
          attempt: attemptNum,
          from: status.state,
          to: 'failed',
          detail: {
            finished_at: new Date().toISOString(),
            phase: 'terminal',
            failure_reason: 'adapter_start_failed',
            failure: { class: 'worker_launch', message: err && err.message ? err.message : 'Adapter failed to start' },
          },
        });
      }
    } catch {}
    if (err && !err.exitCode) err.exitCode = 18;
    throw err;
  }

  try {
    adapter.PrepareInvocation(attempt, request);
    await adapter.Start(attempt);
    if (hardTimedOut || cancelled) throw null;
    if (onStarted) onStarted(attempt);
    await adapter.SendPrompt(attempt, prompt);
    if (hardTimedOut || cancelled) throw null;
  } catch (err) {
    clearTimeout(hardTimeoutTimer);
    if (hardTimedOut) return finishTimedOut();
    if (cancelled) return finishCancelled();
    return abandon(err);
  }

  const resolveSessionId = (collected) => collected.backend_session_id || fallbackSessionId || null;

  try {
    for await (const fact of raceObserve(adapter.Observe(attempt), hardDeadline)) {
      if (hardTimedOut || cancelled) throw null;
      facts.push(fact);
      persistStartedFact(store, repoKey, jobId, attemptNum, fact);

      if (fact.type === 'process_exited') {
        clearTimeout(hardTimeoutTimer);
        // If cancelled by external request, don't report process_exited as done.
        if (cancelled && !hardTimedOut) throw null;
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
          return { text: '', jobId, envelope: buildEnvelope(finalStatus), exitCode: 11, terminalState: 'failed' };
        }
        try { persistBackendEvents({ store, repoKey, jobId, attemptNum, facts }); } catch {}
        try { persistFindings({ store, repoKey, jobId, attemptNum, text: collected.text }); } catch {}

        const terminalFailure = classifyTerminalFailure({
          exitCode, resultBytes, reducerResult: result, resultStatus: collected.result_status,
        });
        // The classifier may override the state (a backend that exited 0 but
        // produced no result file is not `done`); the exit code must follow it.
        const effectiveState = terminalFailure.terminalState || terminalState;

        store.journalTransition(jobId, repoKey, {
          kind: 'attempt_state_changed',
          attempt: attemptNum,
          from: 'running',
          to: effectiveState,
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
          exitCode: terminalExitCode(effectiveState, terminalFailure.failure, terminalFailure.failure_reason),
          terminalState: effectiveState,
        };
      }
    }
  } catch (err) {
    clearTimeout(hardTimeoutTimer);
    if (err && err[HARD_TIMEOUT_ERROR]) hardTimedOut = true;
    if (hardTimedOut) return finishTimedOut();
    if (cancelled) return finishCancelled();
    return abandon(err);
  }

  clearTimeout(hardTimeoutTimer);

  if (hardTimedOut) return finishTimedOut();
  if (cancelled) return finishCancelled();

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
    exitCode: terminalExitCode(terminalState, result.failure, result.failure_reason || (terminalState === 'interrupted' ? 'observe_ended' : null)),
    terminalState,
  };
}

/**
 * Build a `cancelSignal` backed by the `cancel.request` file. `dcli cancel`
 * writes that file atomically (core/cancel.js), so both the worker and a
 * foreground run observe cancellation the same way. The poller is unref'd —
 * it must never keep a process alive by itself — but the attempt driver's own
 * refed timers (heartbeat, Observe race) keep the owner alive while it works.
 *
 * @param {{ jobDir: string, pollMs?: number }} a
 * @returns {CancelSignal}
 */
function createCancelSignal({ jobDir, pollMs = CANCEL_WATCH_MS }) {
  let cancelled = false;
  let timer = null;
  function check() {
    if (cancelled) return;
    let found = false;
    try { found = fs.existsSync(path.join(jobDir, 'cancel.request')); } catch {}
    if (found) {
      cancelled = true;
      return;
    }
    timer = setTimeout(check, pollMs);
    if (timer.unref) timer.unref();
  }
  // Check immediately so a cancel.request written before the attempt started
  // is still acted on, rather than waiting out the first poll interval.
  check();
  return {
    isCancelled: () => cancelled,
    dispose: () => { if (timer) clearTimeout(timer); timer = null; },
  };
}

function persistStartedFact(store, repoKey, jobId, attemptNum, fact) {
  if (!fact || fact.type !== 'started') return;
  const detail = {};
  if (fact.backend_pid !== undefined) detail.backend_pid = fact.backend_pid;
  if (fact.backend_session_id !== undefined) detail.backend_session_id = fact.backend_session_id;
  // Data forwarded verbatim from the adapter: the adapter knows whether the
  // spawn it performed is contained (no platform or backend branch here).
  if (fact.containment !== undefined) detail.containment = fact.containment;
  if (Object.keys(detail).length === 0) return;
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed',
    attempt: attemptNum,
    from: 'running',
    to: null,
    detail,
  });
}

/**
 * Normalise a tree-kill survivor (`{ pid, imagePath, reason }`) into the
 * persisted record shape shared with core/cancel.js.
 */
function survivorToRecord(survivor) {
  return {
    pid: survivor.pid,
    image_path: survivor.imagePath != null ? survivor.imagePath : null,
    reason: survivor.reason || 'still_running',
  };
}

const HARD_TIMEOUT_ERROR = Symbol('hard_timeout');

// The single definition of the Observe deadline race. The per-iteration
// `setTimeout` is deliberately REFED (never unref'd): an unref'd timer lets
// the process exit 0 mid-drain the instant the adapter's own handles are
// released — the silent-success defect in lessons.md §3, fixed four times.
// The worker's copy had `throw()` forwarding that the foreground's lacked;
// this is that stricter shape.
function raceObserve(iterator, deadline) {
  if (!deadline) return iterator;
  return {
    [Symbol.asyncIterator]() {
      const iter = iterator[Symbol.asyncIterator]();
      return {
        async next() {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            const err = new Error('Hard timeout reached');
            err[HARD_TIMEOUT_ERROR] = true;
            throw err;
          }
          let timer;
          try {
            const result = await Promise.race([
              iter.next().then(value => ({ value, source: 'iter' })),
              new Promise(resolve => {
                timer = setTimeout(() => resolve({ value: { done: true }, source: 'timer' }), remaining);
              }),
            ]);
            if (result.source === 'timer') {
              const err = new Error('Hard timeout reached');
              err[HARD_TIMEOUT_ERROR] = true;
              throw err;
            }
            return result.value;
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
        async return() {
          return typeof iter.return === 'function' ? iter.return() : { done: true };
        },
        async throw(err) {
          if (typeof iter.throw === 'function') return iter.throw(err);
          throw err;
        },
      };
    },
  };
}

module.exports = { driveAttempt, createCancelSignal, persistStartedFact, raceObserve, HARD_TIMEOUT_ERROR, tryDisposeAdapter };
