const fs = require('fs');
const path = require('path');
const { readTail } = require('../bounded-tail');
const { loadJobOrThrow } = require('./index');

const DEFAULT_MAX_BYTES = 4096;

async function executeTail({ store, repoKey, jobId, maxBytes }) {
  const { attemptDir } = loadJobOrThrow({ store, repoKey, jobId });
  const max = (typeof maxBytes === 'number' && maxBytes > 0) ? maxBytes : DEFAULT_MAX_BYTES;

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
