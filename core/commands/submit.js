const { generateJobId } = require('../job-id');
const { buildEnvelope } = require('./index');

function executeSubmit({ store, repoKey, repoRoot, prompt, hardTimeoutSec, group, label, model }) {
  const jobId = generateJobId();

  store.createJob({
    jobId, repoKey, repoRoot,
    backend: 'fake',
    backendVersion: '1.0.0',
    adapterVersion: '1.0.0',
    mode: 'submit',
    access: 'read-only',
    group, label, model,
    hardTimeoutSec,
  });

  return { jobId };
}

module.exports = { executeSubmit };
