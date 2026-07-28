const { buildEnvelope } = require('./index');

async function executeStatus({ store, repoKey, jobId }) {
  let status;
  try {
    status = store.regenerateStatus({ repoKey, jobId });
  } catch (err) {
    const e = new Error(`Job not found: ${repoKey}/${jobId}`);
    e.exitCode = 3;
    throw e;
  }

  return { envelope: buildEnvelope(status), status };
}

module.exports = { executeStatus };
