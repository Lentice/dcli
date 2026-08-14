/**
 * The single owner of the failure-class ↔ exit-code mapping (design-spec §7).
 *
 * Append-only contract: adding a class or a code is allowed, changing an
 * existing value is not. Both directions are derived from one frozen literal so
 * they cannot disagree. This module must never *classify* (design-spec §8 — a
 * bare number is not a discriminator); it only maps an already-named class to
 * its contract code and back.
 */

const FAILURE_CLASS_TO_EXIT_CODE = Object.freeze({
  backend_execution_failed: 10,
  no_result: 11,
  environment: 12,
  authentication: 13,
  quota_or_rate_limit: 14,
  permission_or_sandbox: 15,
  network_error: 16,
  lock: 17,
  worker_launch: 18,
  protocol: 26,
  repository_state_unverified: 27,
});

const FAILURE_CLASSES = Object.freeze(Object.keys(FAILURE_CLASS_TO_EXIT_CODE));

const EXIT_CODE_TO_FAILURE_CLASS = Object.freeze(
  Object.fromEntries(Object.entries(FAILURE_CLASS_TO_EXIT_CODE).map(([cls, code]) => [code, cls]))
);

function failureClassToExitCode(cls) {
  return FAILURE_CLASS_TO_EXIT_CODE[cls] ?? null;
}

function exitCodeToFailureClass(code) {
  return EXIT_CODE_TO_FAILURE_CLASS[code] ?? null;
}

// Threshold below which a non-zero-exit result is treated as "no usable
// result produced" (the backend emitted only a few dozen bytes of
// "I'll dispatch..." boilerplate before exiting 1). Conservative: every real review/analysis result observed in
// production is well above this size.
const NO_RESULT_BYTE_THRESHOLD = 512;

/**
 * Derive the journal-ready failure_reason / failure for a terminal attempt
 * from the reducer's projection plus a byte-size heuristic. When the reducer
 * already supplied a failure_reason (e.g. 'hard_timeout'), it is preserved —
 * the no-result heuristic only fills in for otherwise-unexplained non-zero
 * exits with an unusably small result.
 *
 * @param {{ exitCode:number|null, resultBytes:number, reducerResult:Object }} args
 * @returns {{ failure_reason:string|null, failure:Object|null }}
 */
function classifyTerminalFailure({ exitCode, resultBytes, reducerResult, resultStatus }) {
  const failure_reason = (reducerResult && reducerResult.failure_reason) || null;
  const failure = (reducerResult && reducerResult.failure) || null;
  // A hard kill commonly races the result-file write. Preserve an intentional
  // cancellation instead of relabelling it as a backend artifact failure.
  if (reducerResult && (reducerResult.state === 'cancelled' || reducerResult.state === 'timed_out')) {
    return { failure_reason, failure };
  }
  if (typeof resultBytes === 'number' && resultBytes > 0) {
    return { failure_reason, failure };
  }
  // The adapter could not read back the result the backend was told to write.
  // A backend that exits 0 having produced nothing is not a clean run, and
  // reporting it as one is the "a failure must never read as a clean result"
  // defect: the caller gets `done` with an empty result and no reason.
  if (resultStatus === 'missing') {
    return {
      failure_reason: 'result_missing',
      failure: { ...(failure || {}), class: 'no_result', message: 'Backend produced no result file' },
      terminalState: 'failed',
    };
  }
  if (exitCode && exitCode !== 0 &&
      typeof resultBytes === 'number' && resultBytes < NO_RESULT_BYTE_THRESHOLD) {
    // Precedence: a missing/unusable result is 11; only a failed execution
    // with usable output is the generic backend failure 10.
    if (!failure_reason || failure_reason === 'backend_execution_failed') {
      return {
        failure_reason: 'backend_exited_no_result',
        failure: { ...(failure || {}), class: 'no_result' },
      };
    }
  }
  return { failure_reason, failure };
}

function terminalExitCode(state, failure, failureReason) {
  if (state === 'done' || state === 'interrupted' || state === 'cancelled') return 0;
  if (failureReason === 'hard_timeout') return 24;
  if (failureReason === 'result_persistence_failed') return 11;
  // 1 is reserved for an unclassified wrapper-side error.
  return FAILURE_CLASS_TO_EXIT_CODE[(failure && (failure.class || failure.class_hint)) || failureReason] ?? 1;
}

module.exports = {
  FAILURE_CLASSES,
  failureClassToExitCode,
  exitCodeToFailureClass,
  classifyTerminalFailure,
  terminalExitCode,
  NO_RESULT_BYTE_THRESHOLD,
};
