const { generateJobId } = require('../job-id');
const { buildEnvelope, isVersionInRange } = require('./index');

function executeSubmit({ store, adapter, repoKey, repoRoot, prompt, hardTimeoutSec, group, label, model, access, reasoningEffort, variant, effort, admission, resumeJobId }) {
  const jobId = generateJobId();

  let parentStatus = null;
  let parentRootJobId = null;
  if (resumeJobId) {
    try {
      parentStatus = store.readStatus({ repoKey, jobId: resumeJobId });
    } catch {
      const err = new Error(`Parent job not found for --resume: ${resumeJobId}`);
      err.exitCode = 3;
      throw err;
    }
    parentRootJobId = parentStatus.root_job_id || resumeJobId;
  }

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

  const inheritedGroup = group || (parentStatus ? parentStatus.group : null);
  const inheritedLabel = label || (parentStatus ? parentStatus.label : null);
  const inheritedAccess = access || (parentStatus ? parentStatus.access : null) || 'read-only';

  store.createJob({
    jobId, repoKey, repoRoot,
    backend,
    backendVersion,
    adapterVersion,
    mode: 'submit',
    access: inheritedAccess,
    group: inheritedGroup,
    label: inheritedLabel,
    model,
    hardTimeoutSec,
    capabilitiesSnapshot,
    parentJobId: resumeJobId || null,
    rootJobId: parentRootJobId || null,
    sessionStrategy: resumeJobId ? 'fork_from_artifacts' : null,
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
