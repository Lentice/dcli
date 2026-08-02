const fs = require('fs');
const path = require('path');
const { writeTextFileAtomic } = require('./fs-text');
const { isProcessAlive } = require('./process-identity');
const { maybeInject } = require('./inject-points');
const { TERMINAL } = require('./reducer');

const DEFAULT_RUNG_WAIT_MS = 2000;
const DEFAULT_HARD_KILL_WAIT_MS = 3000;

/**
 * Cancel a job by walking adapter-declared escalation rungs.
 *
 * 1. Writes cancel.request atomically and journals cancel_requested_at
 * 2. Walks the rungs the adapter declared, each with bounded wait + postcondition check
 * 3. If no declared rung killed the process, hard-kill via containment
 * 4. Verifies termination via isProcessAlive before writing cancelled
 * 5. Records the successful rung in backend_state
 *
 * @param {object} opts
 * @param {object} opts.store - JobStore instance
 * @param {object} opts.adapter - Adapter instance implementing DeclareCancelRungs and RequestCancel
 * @param {string} opts.jobDir - Job directory path
 * @param {string} opts.repoKey - Repository key
 * @param {string} opts.jobId - Job ID
 * @param {object} opts.attempt - Attempt object passed to adapter methods
 * @param {number} opts.attemptNum - Attempt number for journaling
 * @param {object|null} [opts.containment] - ContainmentContext for hard kill (must have terminate method)
 * @param {string|null} [opts.executionToken] - Execution token for containment verification
 * @param {number|null} [opts.pid] - Process PID for aliveness check
 * @param {function} [opts.isProcessAliveFn] - Injected aliveness checker (default: isProcessAlive)
 * @param {number} [opts.rungWaitMs] - Bounded wait per rung in ms
 * @param {number} [opts.hardKillWaitMs] - Bounded wait after hard kill in ms
 * @returns {Promise<{state: string, cancelRungReached: string|null, exitCode: number, warning?: string}>}
 */
async function cancelJob(opts) {
  const {
    store, adapter, jobDir, repoKey, jobId,
    attempt, attemptNum,
    containment, executionToken, pid,
    isProcessAliveFn = isProcessAlive,
    rungWaitMs = DEFAULT_RUNG_WAIT_MS,
    hardKillWaitMs = DEFAULT_HARD_KILL_WAIT_MS,
  } = opts;

  const status = store.readStatus({ repoKey, jobId });

  if (TERMINAL.has(status.state)) {
    return { state: status.state, cancelRungReached: null, exitCode: 0 };
  }

  // Without a pid there is nothing to observe, and `isProcessAlive(null)` is
  // false — so a naive loop declares the FIRST rung successful every time and
  // reports `cancelled` while killing nothing (AGENTS.md Mistake #5). The only
  // honest signal left is the worker acting on cancel.request itself.
  const pidKnown = typeof pid === 'number' && pid > 0;
  // A job that never reached `running` has no process by construction, so
  // writing `cancelled` for it is honest. `running` with no identity is the
  // dangerous case: something IS executing and we cannot touch it.
  const started = status.state === 'running';

  // Sample liveness BEFORE anything is written. Two reasons, and the order
  // matters for both: a worker that had already exited otherwise made the
  // first rung look successful, and — because the reducer maps a pending
  // cancel_requested_at straight to `cancelled` — annotating first would make
  // reconciliation report a crashed worker as cleanly cancelled, hiding the
  // real outcome behind a cancellation nobody performed.
  if (pidKnown && !isProcessAliveFn(pid)) {
    const reconciled = store.reconcileStatus({ repoKey, jobId });
    if (TERMINAL.has(reconciled.state)) {
      return { state: reconciled.state, cancelRungReached: 'already_exited', exitCode: 0 };
    }
    return {
      state: reconciled.state,
      cancelRungReached: 'already_exited',
      exitCode: 21,
      warning: 'termination_unconfirmed',
    };
  }

  const now = new Date().toISOString();

  const cancelRequestPath = path.join(jobDir, 'cancel.request');
  writeTextFileAtomic(cancelRequestPath, JSON.stringify({ requested_at: now, job_id: jobId }));

  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed',
    attempt: attemptNum,
    from: status.state || null,
    to: null,
    detail: { cancel_requested_at: now },
  });

  maybeInject('cancel-before-rungs');

  const rungs = adapter.DeclareCancelRungs();
  let cancelRungReached = null;

  for (const rung of rungs) {
    if (cancelRungReached) break;
    await adapter.RequestCancel(attempt, rung);
    await boundedSleep(rungWaitMs);
    if (pidKnown && !isProcessAliveFn(pid)) {
      cancelRungReached = rung;
      break;
    }
  }

  // No rung of ours reached the process. A detached worker still cancels
  // itself: it polls cancel.request and publishes its own terminal state. That
  // is a real, observable confirmation, so wait for it — boundedly — before
  // falling through to the kill path.
  if (!cancelRungReached && started) {
    const selfCancelDeadline = Date.now() + hardKillWaitMs;
    while (Date.now() < selfCancelDeadline) {
      const current = store.reconcileStatus({ repoKey, jobId });
      if (TERMINAL.has(current.state)) {
        // Only `cancelled` is a self-cancellation. A job that finished, failed
        // or timed out while we waited reached that state on its own, and
        // labelling it a successful cancel claims an effect we did not have.
        return {
          state: current.state,
          cancelRungReached: current.state === 'cancelled' ? 'worker_self_cancel' : 'completed_before_cancel',
          exitCode: 0,
        };
      }
      await boundedSleep(200);
    }
  }

  if (!pidKnown && !cancelRungReached && started) {
    // Nothing to kill and nothing killed itself. Never write `cancelled` here.
    return {
      state: store.reconcileStatus({ repoKey, jobId }).state,
      cancelRungReached: 'worker_identity_unknown',
      exitCode: 21,
      warning: 'termination_unconfirmed',
    };
  }

  // Every declared rung failed. The last resort is a contained tree kill — but it only
  // exists when a ContainmentContext owns the tree. Record which of the two actually
  // happened: 'hard_kill' is an ADAPTER RUNG NAME, so reusing it here would make "the
  // adapter's hard_kill rung worked" indistinguishable from "we killed the Job Object"
  // and from "we did nothing at all" (AGENTS.md Mistake #5: a cancel that wrote
  // `cancelled` while killing nothing).
  /** @type {{terminated: boolean, survivors?: number[], error?: string}|null} */
  let containedKill = null;
  if (!cancelRungReached) {
    if (containment && typeof containment.terminate === 'function') {
      try {
        containedKill = await containment.terminate({ executionToken: executionToken || undefined });
      } catch (err) {
        containedKill = { terminated: false, error: err.message };
      }
      await boundedSleep(hardKillWaitMs);
      cancelRungReached = 'contained_tree_kill';
    } else {
      // No Job Object owns this tree, so nothing was killed. Say so.
      await boundedSleep(hardKillWaitMs);
      cancelRungReached = 'containment_unavailable';
    }
  }

  // A helper that reports survivors has NOT delivered a clean kill, even if the root pid
  // is gone — a surviving grandchild still holds ports, temp dirs and pipes.
  const killReportedSurvivors = containedKill !== null && containedKill.terminated !== true;

  if (isProcessAliveFn(pid) || killReportedSurvivors) {
    return {
      state: status.state,
      cancelRungReached,
      exitCode: 21,
      warning: 'termination_unconfirmed',
      ...(containedKill ? { survivors: containedKill.survivors || [] } : {}),
    };
  }

  // The worker may have published a terminal result while the cancel rung was
  // waiting. Re-read before writing `cancelled`; a late cancel must never
  // demote a completed job.
  const afterKill = store.reconcileStatus({ repoKey, jobId });
  if (TERMINAL.has(afterKill.state)) {
    return { state: afterKill.state, cancelRungReached, exitCode: 0 };
  }

  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed',
    attempt: attemptNum,
    from: status.state || null,
    to: 'cancelled',
    detail: {
      finished_at: now,
      cancel_requested_at: now,
      backend_state: { schema_version: 1, cancel_rung_reached: cancelRungReached },
    },
  });

  return { state: 'cancelled', cancelRungReached, exitCode: 0 };
}

function boundedSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { cancelJob };
