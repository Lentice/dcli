const { cancelJob } = require('../cancel');
const { buildEnvelope, loadJobOrThrow } = require('./index');
const { isProcessAlive, parseWorkerIdentity } = require('../process-identity');

async function executeCancel({ store, adapter, repoKey, jobId, json }) {
  if (!jobId) {
    const err = new Error('cancel requires a job ID');
    err.exitCode = 2;
    throw err;
  }

  const { status, attemptNum, jobDir } = loadJobOrThrow({ store, repoKey, jobId, regenerate: false });

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
