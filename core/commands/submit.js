const { generateJobId } = require('../job-id');
const { buildEnvelope, isVersionInRange } = require('./index');

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

  const detectedVersion = adapter.DetectVersion();
  const manifest = adapter.ProbeCapabilities();
  if (manifest.supported_version_range) {
    if (!isVersionInRange(detectedVersion, manifest.supported_version_range)) {
      const range = manifest.supported_version_range;
      const err = new Error(
        `Backend version ${detectedVersion} is outside supported range ` +
        `${range.min || 'any'} - ${range.max || 'any'}. Cannot create job.`
      );
      err.code = 'VERSION_OUT_OF_RANGE';
      err.exitCode = 12;
      throw err;
    }
  }

  const capabilitiesSnapshot = manifest;

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
