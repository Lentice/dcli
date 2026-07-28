const { generateJobId } = require('../job-id');
const { buildEnvelope } = require('./index');

function executeSubmit({ store, adapter, repoKey, repoRoot, prompt, hardTimeoutSec, group, label, model, reasoningEffort, variant, effort }) {
  const jobId = generateJobId();

  const request = { model, reasoningEffort, variant, effort };
  try {
    adapter.ValidateRequest(request);
  } catch (err) {
    if (err.code === 'VALIDATION_FAILED') {
      err.exitCode = 2;
      throw err;
    }
    throw err;
  }

  const capabilitiesSnapshot = adapter.ProbeCapabilities();

  store.createJob({
    jobId, repoKey, repoRoot,
    backend: 'fake',
    backendVersion: '1.0.0',
    adapterVersion: '1.0.0',
    mode: 'submit',
    access: 'read-only',
    group, label, model,
    hardTimeoutSec,
    capabilitiesSnapshot,
  });

  return { jobId };
}

module.exports = { executeSubmit };
