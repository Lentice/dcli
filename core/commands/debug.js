const fs = require('fs');
const path = require('path');
const { isProcessAlive, parseWorkerIdentity } = require('../process-identity');
const { loadJobOrThrow } = require('./index');

const STDER_TAIL_BYTES = 4096;

async function executeDebug({ store, repoKey, jobId }) {
  const { status, attemptNum: attempt, jobDir, attemptDir } = loadJobOrThrow({ store, repoKey, jobId });

  const report = {
    job_id: status.job_id || jobId,
    state: status.state || 'unknown',
    phase: status.phase || null,
    attempt,
    backend: status.backend || null,
    warning: null,
    cancel_rungs: null,
    cancel_rung_used: null,
    timings: {
      created_at: status.created_at || null,
      started_at: status.started_at || null,
      heartbeat_at: status.heartbeat_at || null,
      finished_at: status.finished_at || null,
    },
    worker: {
      pid: status.worker_pid || null,
      identity: status.worker_identity || null,
      alive: null,
    },
    containment: {
      kind: null,
      degraded: false,
    },
    result: {
      present: false,
      bytes: 0,
      findings_status: status.findings_status || null,
    },
    stderr: null,
  };

  // Worker liveness
  if (status.worker_identity) {
    const parsed = parseWorkerIdentity(status.worker_identity);
    if (parsed) {
      report.worker.alive = isProcessAlive(parsed.pid);
    }
  } else if (status.worker_pid) {
    report.worker.alive = isProcessAlive(status.worker_pid);
  }

  // Containment info
  if (status.containment && typeof status.containment === 'object') {
    report.containment = {
      kind: status.containment.kind || null,
      degraded: !!status.containment.degraded,
    };
  }

  // Result presence
  const resultPath = path.join(attemptDir, 'result.md');
  if (fs.existsSync(resultPath)) {
    const stat = fs.statSync(resultPath);
    report.result.present = true;
    report.result.bytes = stat.size;
  }

  // Cancel info
  if (status.cancel_requested_at) {
    report.cancel_rungs = ['hard_kill'];
    report.cancel_rung_used = status.cancel_requested_at ? 'requested' : null;
  }

  // Process-outlives-completion warning
  const sentinelPath = path.join(attemptDir, 'worker-complete.json');
  const sentinelExists = fs.existsSync(sentinelPath);
  if (report.worker.alive && sentinelExists) {
    report.warning = 'process_outlived_completion';
  }

  // Stderr tail (bounded)
  const stderrPath = path.join(attemptDir, 'stderr.log');
  if (fs.existsSync(stderrPath)) {
    const { readTail } = require('../bounded-tail');
    report.stderr = readTail(stderrPath, STDER_TAIL_BYTES);
  }

  return report;
}

module.exports = { executeDebug };
