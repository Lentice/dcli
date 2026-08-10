const { cancelJob } = require('../cancel');
const { buildEnvelope } = require('../envelope');
const { loadJobOrThrow } = require('../job-lookup');
const { isProcessAlive, isSameProcessAlive, parseWorkerIdentity } = require('../process-identity');

async function executeCancel({ store, adapter, repoKey, jobId, json }) {
  if (!jobId) {
    const err = new Error('cancel requires a job ID');
    err.exitCode = 2;
    throw err;
  }

  const { status, attemptNum, jobDir } = loadJobOrThrow({ store, repoKey, jobId, regenerate: false });

  let pid = null;
  // Liveness must be judged against the recorded identity, not the bare pid.
  // A reused pid otherwise reads as "the worker is still running" — or, after
  // a rung, as "it is gone" — for a process that was never the worker, which
  // is exactly the confirmation this command exists to give honestly.
  const identity = parseWorkerIdentity(status.worker_identity);
  let isProcessAliveFn = isProcessAlive;
  if (identity) {
    pid = identity.pid;
    // Verify ownership once before signalling. Repeating the Windows identity
    // query for every rung would spawn PowerShell and consume the rung budget.
    let identityVerified = false;
    isProcessAliveFn = () => {
      if (!identityVerified) {
        const alive = isSameProcessAlive(identity);
        if (alive) identityVerified = true;
        return alive;
      }
      return isProcessAlive(identity.pid);
    };
  } else if (status.worker_pid) {
    pid = status.worker_pid;
  }

  const result = await cancelJob({
    store, adapter, jobDir, repoKey, jobId,
    attempt: {},
    attemptNum,
    containment: null,
    executionToken: status.execution_token || null,
    pid,
    isProcessAliveFn,
  });

  if (json) {
    const finalStatus = store.readStatus({ repoKey, jobId });
    result.envelope = buildEnvelope(finalStatus);
  }

  return result;
}

module.exports = { executeCancel };
