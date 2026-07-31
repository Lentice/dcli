const { buildEnvelope, loadJobOrThrow } = require('./index');

async function executeStatus({ store, repoKey, jobId }) {
  const { status } = loadJobOrThrow({ store, repoKey, jobId });

  return { envelope: buildEnvelope(status), status };
}

module.exports = { executeStatus };
