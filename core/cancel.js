const fs = require('fs');
const path = require('path');
const { writeTextFileAtomic } = require('./fs-text');
const { isProcessAlive } = require('./process-identity');
const { maybeInject } = require('./inject-points');

const DEFAULT_RUNG_WAIT_MS = 2000;
const DEFAULT_HARD_KILL_WAIT_MS = 3000;

const TERMINAL = Object.freeze(new Set(['done', 'failed', 'timed_out', 'cancelled', 'interrupted']));

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
    await adapter.RequestCancel(attempt, rung);
    await boundedSleep(rungWaitMs);
    if (!isProcessAliveFn(pid)) {
      cancelRungReached = rung;
      break;
    }
  }

  if (!cancelRungReached) {
    if (containment && typeof containment.terminate === 'function') {
      await containment.terminate({ executionToken: executionToken || undefined });
    }
    await boundedSleep(hardKillWaitMs);
    cancelRungReached = 'hard_kill';
  }

  if (isProcessAliveFn(pid)) {
    return { state: status.state, cancelRungReached, exitCode: 21, warning: 'termination_unconfirmed' };
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

module.exports = { cancelJob, DEFAULT_RUNG_WAIT_MS, DEFAULT_HARD_KILL_WAIT_MS };
