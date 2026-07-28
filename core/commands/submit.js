const { generateJobId } = require('../job-id');
const { buildEnvelope, isVersionInRange } = require('./index');

function executeSubmit({ store, adapter, repoKey, repoRoot, prompt, hardTimeoutSec, group, label, model, access, reasoningEffort, variant, effort, admission }) {
  const jobId = generateJobId();

  const request = { model, canonicalDir: repoRoot, reasoningEffort, variant, effort, access };
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

  const identity = adapter.GetIdentity();
  const backend = identity.backend || 'fake';
  const backendVersion = detectedVersion || '1.0.0';
  const adapterVersion = identity.adapter_version || '1.0.0';
  const effectiveAccess = access || 'read-only';

  store.createJob({
    jobId, repoKey, repoRoot,
    backend,
    backendVersion,
    adapterVersion,
    mode: 'submit',
    access: effectiveAccess,
    group, label, model,
    hardTimeoutSec,
    capabilitiesSnapshot,
  });

  if (admission) {
    const result = admission.acquireSlot(backend);
    if (!result.acquired) {
      store.journalTransition(jobId, repoKey, {
        kind: 'attempt_state_changed',
        attempt: null,
        from: 'created',
        to: 'queued',
        detail: { phase: 'queued', queue_reason: result.reason },
      });
      admission.enqueueJob(backend, jobId);
    }
  }

  return { jobId };
}

module.exports = { executeSubmit };
