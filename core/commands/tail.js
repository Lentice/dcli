const fs = require('fs');
const path = require('path');
const { readTail } = require('../bounded-tail');

const DEFAULT_MAX_BYTES = 4096;

async function executeTail({ store, repoKey, jobId, maxBytes }) {
  let status;
  try {
    status = store.regenerateStatus({ repoKey, jobId });
  } catch (err) {
    const e = new Error(`Job not found: ${repoKey}/${jobId}`);
    e.exitCode = 3;
    throw e;
  }

  const max = (typeof maxBytes === 'number' && maxBytes > 0) ? maxBytes : DEFAULT_MAX_BYTES;
  const jobDir = store.getJobDir(repoKey, jobId);
  const attempt = status.attempt || 1;
  const attemptDir = path.join(jobDir, 'attempts', String(attempt));

  const result = { worker: null, backendEvents: null };

  const workerLogPath = path.join(attemptDir, 'worker.log');
  if (fs.existsSync(workerLogPath)) {
    result.worker = readTail(workerLogPath, max);
  }

  const backendEventsPath = path.join(attemptDir, 'backend-events.jsonl');
  if (fs.existsSync(backendEventsPath)) {
    result.backendEvents = readTail(backendEventsPath, max);
  }

  return result;
}

module.exports = { executeTail };
