function buildEnvelope(status) {
  return {
    schema_version: 1,
    job_id: status.job_id || null,
    backend: status.backend || null,
    state: status.state || 'created',
    phase: status.phase || null,
    attempt: status.attempt !== undefined && status.attempt !== null ? status.attempt : null,
    command_exit_code: status.command_exit_code !== undefined ? status.command_exit_code : null,
    backend_exit_code: status.backend_exit_code !== undefined ? status.backend_exit_code : null,
    failure_reason: status.failure_reason || null,
    failure: status.failure || null,
    findings: null,
    findings_status: status.findings_status || null,
    truncation_info: null,
    untracked_warning: null,
    // A taskkill-tree rung's survivor set (ticket 103): non-empty means a kill
    // was attempted but left processes alive, which is why a cancel that
    // reaches this state exits 21 instead of reporting a clean cancellation.
    containment_survivors: status.containment_survivors || null,
  };
}

function buildErrorEnvelope(error) {
  return {
    schema_version: 1,
    failure_class: error.failureClass || null,
    exit_code: error.exitCode || 1,
    repository_restored: error.repositoryRestored === undefined ? null : error.repositoryRestored,
    detail: error.message,
  };
}

module.exports = { buildEnvelope, buildErrorEnvelope };
