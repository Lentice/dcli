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
 */

const TERMINAL = Object.freeze(new Set(['done', 'failed', 'timed_out', 'cancelled', 'interrupted']));

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

  // 1. Already terminal — idempotent
  if (TERMINAL.has(state.state)) {
    return pick(state, ['state', 'phase', 'failure', 'failure_reason', 'backend_session_id']);
  }

  // 2. Cancel requested → cancelled (any non-terminal state, including created)
  if (state.cancel_requested_at) {
    return {
      state: 'cancelled',
      phase: 'terminal',
      failure_reason: state.failure_reason || null,
      backend_session_id: state.backend_session_id || null,
    };
  }

  // 3. Hard timeout → timed_out
  if (state.hard_timeout_sec && state.started_at) {
    const deadline = new Date(state.started_at).getTime() + state.hard_timeout_sec * 1000;
    if (Number.isFinite(deadline) && Date.now() > deadline) {
      return {
        state: 'timed_out',
        phase: 'terminal',
        failure_reason: state.failure_reason || null,
        backend_session_id: state.backend_session_id || null,
      };
    }
  }

  // 4. Process facts
  const processExited = facts.find(f => f && f.type === 'process_exited');
  if (processExited) {
    return {
      state: processExited.code === 0 ? 'done' : 'failed',
      phase: 'terminal',
      failure: processExited.code !== 0 ? { reason: 'process_error', code: processExited.code } : null,
      failure_reason: state.failure_reason || null,
      backend_session_id: state.backend_session_id || null,
    };
  }

  const backendError = facts.find(f => f && f.type === 'backend_error');
  if (backendError) {
    return {
      state: 'failed',
      phase: 'terminal',
      failure: { reason: 'backend_error' },
      failure_reason: state.failure_reason || null,
      backend_session_id: state.backend_session_id || null,
    };
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
  const heartbeatStale = ev.heartbeatAgeMs !== null && ev.heartbeatAgeMs > 15000;

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
    const exitCode = ev.commandExitCode !== null && ev.commandExitCode !== undefined
      ? ev.commandExitCode
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

module.exports = { reduce };
