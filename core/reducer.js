/**
 * @typedef {Object} Evidence
 * @property {boolean|null} workerAlive - Is the worker process alive by identity+token?
 * @property {boolean|null} completionSentinelPresent - Does worker-complete.json exist?
 * @property {number|null} resultBytes - Size of result file
 * @property {number|null} heartbeatAgeMs - Age of last heartbeat in ms
 * @property {string|null} jobId - Job ID from evidence files (for job-id matching)
 * @property {string|null} executionToken - Execution token from evidence
 * @property {boolean|null} executionTokenMatch - Does execution token match the expected one?
 * @property {number|null} commandExitCode - Exit code from evidence
 * @property {string|null} sentinelState - Terminal state the worker published in its sentinel
 * @property {boolean|null} workerIdentityMissing - No usable worker identity or pid is recorded
 */

const TERMINAL = Object.freeze(new Set(['done', 'failed', 'timed_out', 'cancelled', 'interrupted']));
const STREAM_CLOSED_ERROR_REASONS = new Set(['sse_disconnect', 'interaction_reject_failed', 'finalization_error']);
const { exitCodeToFailureClass } = require('./failure-class');

/**
 * Engine-owned lifecycle reducer. Takes current state + adapter facts + durable
 * evidence and returns the resolved state, phase, and any warning.
 *
 * Adaptes emit facts; this reducer decides state. Never backend-conditional.
 *
 * @param {Object} state - Current status projection
 * @param {Array} facts - Adapter facts emitted during this attempt
 * @param {Evidence} evidence - Durable evidence about the worker
 * @returns {{ state: string, phase: string|null, failure?: Object|null,
 *            failure_reason?: string|null, backend_session_id?: string|null,
 *            warning?: string|null }}
 */
function reduce(state, facts, evidence) {
  if (!state || typeof state !== 'object') {
    throw new Error('reducer: state must be a non-null object');
  }
  if (!facts || !Array.isArray(facts)) {
    throw new Error('reducer: facts must be an array');
  }

  const ev = evidence && typeof evidence === 'object' ? evidence : {};

  const hardTimeoutElapsed = state.hard_timeout_sec && state.started_at
    ? (() => {
      const deadline = new Date(state.started_at).getTime() + Number(state.hard_timeout_sec) * 1000;
      return Number.isFinite(deadline) && Date.now() > deadline;
    })()
    : false;
  const hasWorkerPid = Number.isInteger(state.worker_pid) && state.worker_pid > 0;
  const workerIdentityMissing = ev.workerIdentityMissing === true ||
    (!state.worker_identity && !hasWorkerPid);
  const heartbeatMissing = ev.heartbeatAgeMs === null || ev.heartbeatAgeMs === undefined;
  const heartbeatStale = ev.heartbeatAgeMs !== null && ev.heartbeatAgeMs !== undefined &&
    ev.heartbeatAgeMs > 15000;
  const noCompletionSentinel = ev.completionSentinelPresent !== true;

  // 1. Already terminal — idempotent
  if (TERMINAL.has(state.state)) {
    return pick(state, ['state', 'phase', 'failure', 'failure_reason', 'backend_session_id']);
  }

  // Legacy records may have no proof of which worker owns them. They become
  // decidable only after their own deadline: before then, retiring one could
  // race a still-running backend. This is intentionally not a new age knob.
  if (workerIdentityMissing && (heartbeatMissing || heartbeatStale) &&
      noCompletionSentinel && hardTimeoutElapsed) {
    return {
      state: 'interrupted',
      phase: 'terminal',
      failure: { reason: 'worker_identity_missing' },
      failure_reason: state.failure_reason || 'worker_identity_missing',
      backend_session_id: state.backend_session_id || null,
    };
  }

  // 2. Cancel requested → cancelled (any non-terminal state, including created).
  //    Note this is a projection, not a durable decision: only an authorized
  //    writer (cancelJob, or the worker acting on cancel.request) may journal it.
  //    See reconcileStatus, which must not persist an outcome for a live worker.
  if (state.cancel_requested_at) {
    return {
      state: 'cancelled',
      phase: 'terminal',
      failure_reason: state.failure_reason || null,
      backend_session_id: state.backend_session_id || null,
    };
  }

  // 3. Hard timeout → timed_out
  if (hardTimeoutElapsed) {
    return {
      state: 'timed_out',
      phase: 'terminal',
      failure_reason: state.failure_reason || null,
      backend_session_id: state.backend_session_id || null,
    };
  }

  // 4. Process facts
  const processExited = facts.find(f => f && f.type === 'process_exited');
  const backendError = facts.find(f => f && f.type === 'backend_error');
  // A clean exit does not overrule a reported backend error. Where the backend
  // process outlives the turn it always exits 0, so a provider refusal (a live
  // 403 from the model) reduced to `done` with an empty result and exit 0 —
  // the exact "a failure must never read as a clean result" defect. A non-zero
  // exit still wins, because its code is the more specific fact.
  if (processExited && !(processExited.code === 0 && backendError)) {
    // A non-zero exit wins on state, but it must not swallow the reported
    // class. Dropping it turned a quota exhaustion or an expired login into a
    // bare exit 1, so the caller could not tell "out of credit, do not retry"
    // from "the run failed, retry might work".
    const classHint = (backendError && backendError.class_hint) || null;
    return {
      state: processExited.code === 0 ? 'done' : 'failed',
      phase: 'terminal',
      failure: processExited.code !== 0
        ? { class: classHint, reason: 'process_error', code: processExited.code }
        : null,
      failure_reason: (processExited.code !== 0 ? classHint : null) || state.failure_reason || null,
      backend_session_id: state.backend_session_id || null,
    };
  }

  if (backendError) {
    const classHint = backendError.class_hint || null;
    return {
      state: 'failed',
      phase: 'terminal',
      failure: { class: classHint, reason: 'backend_error' },
      failure_reason: classHint || state.failure_reason || null,
      backend_session_id: state.backend_session_id || null,
    };
  }

  const streamClosed = facts.find(f => f && f.type === 'stream_closed');
  if (streamClosed) {
    if (STREAM_CLOSED_ERROR_REASONS.has(streamClosed.reason)) {
      return {
        state: 'failed',
        phase: 'terminal',
        failure: { class: 'stream_closed', reason: streamClosed.reason },
        failure_reason: 'stream_closed',
        backend_session_id: state.backend_session_id || null,
      };
    }
  }

  // 5. Reconciliation — only for non-terminal states (running/created)
  if (state.state !== 'running' && state.state !== 'created') {
    return noChange(state);
  }

  // Job-id match guard: evidence must name this job or be absent
  const jobIdMatch = !ev.jobId || ev.jobId === state.job_id;
  if (!jobIdMatch) {
    return noChange(state);
  }

  // Malformed-evidence guard: null evidence fields are treated as absent,
  // not as confirmations
  const workerGone = ev.workerAlive === false;
  const hasSentinel = ev.completionSentinelPresent === true;
  // PID-reuse safety: if execution token is provided and doesn't match,
  // treat worker as absent even if workerAlive is true
  const tokenMismatch = ev.executionToken !== undefined && ev.executionToken !== null &&
    ev.executionTokenMatch === false;
  const effectiveWorkerGone = tokenMismatch ? true : workerGone;

  // Warning: process alive but completion evidence present
  if (!effectiveWorkerGone && ev.workerAlive !== null && hasSentinel) {
    return {
      ...noChange(state),
      warning: 'process_outlived_completion',
    };
  }

  // Worker gone + sentinel present → done/failed per producer exit-code contract
  if (effectiveWorkerGone && hasSentinel) {
    // The state the worker published beats an inference from its exit code:
    // an interrupted attempt exits 0 by the CLI contract, and reading that as
    // `done` turned a job that was cut short into a clean success.
    if (typeof ev.sentinelState === 'string' && TERMINAL.has(ev.sentinelState)) {
      // `worker_lost_no_result` describes a worker that vanished without
      // saying anything. This one said exactly what happened, so do not label
      // a clean `cancelled` or `interrupted` as a lost worker, and keep the
      // exit code it recorded.
      const sentinelExitCode = ev.sentinelExitCode !== undefined
        ? ev.sentinelExitCode
        : ev.commandExitCode;
      const lostResult = ev.sentinelState === 'failed' && sentinelExitCode === null;
      const failureClass = exitCodeToFailureClass(sentinelExitCode);
      return {
        state: ev.sentinelState,
        phase: 'terminal',
        failure: lostResult
          ? { reason: 'worker_lost_no_result' }
          : failureClass ? { class: failureClass, reason: 'backend_error', code: sentinelExitCode }
            : (state.failure || null),
        failure_reason: failureClass || state.failure_reason || null,
        backend_session_id: state.backend_session_id || null,
      };
    }
    const exitCode = (ev.sentinelExitCode !== undefined ? ev.sentinelExitCode : ev.commandExitCode) !== null
      ? (ev.sentinelExitCode !== undefined ? ev.sentinelExitCode : ev.commandExitCode)
      : null;
    if (exitCode === 0) {
      return {
        state: 'done',
        phase: 'terminal',
        failure_reason: state.failure_reason || null,
        backend_session_id: state.backend_session_id || null,
      };
    }
    return {
      state: 'failed',
      phase: 'terminal',
      failure: { reason: 'worker_lost_no_result' },
      failure_reason: state.failure_reason || null,
      backend_session_id: state.backend_session_id || null,
    };
  }

  // Worker gone + no sentinel + stale heartbeat → interrupted
  if (effectiveWorkerGone && !hasSentinel && heartbeatStale) {
    return {
      state: 'interrupted',
      phase: 'terminal',
      failure: { reason: 'worker_lost' },
      failure_reason: state.failure_reason || null,
      backend_session_id: state.backend_session_id || null,
    };
  }

  // Worker gone + no sentinel + no heartbeat info → interrupted
  if (effectiveWorkerGone && !hasSentinel && ev.heartbeatAgeMs === null) {
    return {
      state: 'interrupted',
      phase: 'terminal',
      failure: { reason: 'worker_lost' },
      failure_reason: state.failure_reason || null,
      backend_session_id: state.backend_session_id || null,
    };
  }

  // Stale heartbeat + worker gone → interrupted (redundant with above but explicit)
  if (heartbeatStale && (effectiveWorkerGone || ev.workerAlive === null)) {
    return {
      state: 'interrupted',
      phase: 'terminal',
      failure: { reason: 'heartbeat_stale' },
      failure_reason: state.failure_reason || null,
      backend_session_id: state.backend_session_id || null,
    };
  }

  return noChange(state);
}

/**
 * Return current state with no changes.
 */
function noChange(state) {
  return {
    state: state.state,
    phase: state.phase || null,
    failure: state.failure || null,
    failure_reason: state.failure_reason || null,
    backend_session_id: state.backend_session_id || null,
  };
}

/**
 * Pick specific fields from state.
 */
function pick(state, fields) {
  const result = {};
  for (const f of fields) {
    result[f] = state[f] !== undefined ? state[f] : null;
  }
  return result;
}

module.exports = { reduce, TERMINAL };
