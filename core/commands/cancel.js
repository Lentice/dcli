const { cancelJob } = require('../cancel');
const { buildEnvelope } = require('./index');
const { isProcessAlive, parseWorkerIdentity } = require('../process-identity');

async function executeCancel({ store, adapter, repoKey, jobId, json }) {
  if (!jobId) {
    const err = new Error('cancel requires a job ID');
    err.exitCode = 2;
    throw err;
  }

  let status;
  try {
    status = store.readStatus({ repoKey, jobId });
  } catch {
    const err = new Error(`Job not found: ${repoKey}/${jobId}`);
    err.exitCode = 3;
    throw err;
  }

  const jobDir = store.getJobDir(repoKey, jobId);
  const attemptNum = status.attempt || 1;

  let pid = null;
  if (status.worker_identity) {
    const parsed = parseWorkerIdentity(status.worker_identity);
    if (parsed) pid = parsed.pid;
  }
  if (pid === null && status.worker_pid) {
    pid = status.worker_pid;
  }

  const result = await cancelJob({
    store, adapter, jobDir, repoKey, jobId,
    attempt: {},
    attemptNum,
    containment: null,
    executionToken: status.execution_token || null,
    pid,
    isProcessAliveFn: isProcessAlive,
  });

  if (json) {
    const finalStatus = store.readStatus({ repoKey, jobId });
    result.envelope = buildEnvelope(finalStatus);
  }

  return result;
}

module.exports = { executeCancel };
