const { DEFAULT_BACKEND } = require('../../adapters/registry');

// Simple numeric semver-style comparison: returns -1, 0, or 1.
function compareVersions(a, b) {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aVal = aParts[i] || 0;
    const bVal = bParts[i] || 0;
    if (aVal < bVal) return -1;
    if (aVal > bVal) return 1;
  }
  return 0;
}

function isVersionInRange(version, range) {
  if (range.min && compareVersions(version, range.min) < 0) return false;
  if (range.max && compareVersions(version, range.max) >= 0) return false;
  return true;
}

/**
 * Validate the request against the backend, check its version against the
 * capability manifest, and resolve the identity fields every job record
 * needs. run, resume and submit all did this identically before creating a
 * job; a backend that fails the check must never leave a job behind.
 *
 * @param {{ adapter:Object, request:Object }} args
 * @returns {{ manifest:Object, detectedVersion:string, backend:string,
 *             backendVersion:string, adapterVersion:string }}
 */
function prepareBackend({ adapter, request }) {
  try {
    adapter.ValidateRequest(request);
  } catch (err) {
    if (err.code === 'VALIDATION_FAILED') err.exitCode = 2;
    throw err;
  }

  const detectedVersion = adapter.DetectVersion();
  const manifest = adapter.ProbeCapabilities();
  const range = manifest.supported_version_range;
  if (range && !isVersionInRange(detectedVersion, range)) {
    const err = new Error(
      `Backend version ${detectedVersion} is outside supported range ` +
      `${range.min || 'any'} - ${range.max || 'any'}. Cannot create job.`
    );
    err.code = 'VERSION_OUT_OF_RANGE';
    err.exitCode = 12;
    throw err;
  }

  const identity = adapter.GetIdentity();
  return {
    manifest,
    detectedVersion,
    backend: identity.backend || DEFAULT_BACKEND,
    backendVersion: detectedVersion || '1.0.0',
    adapterVersion: identity.adapter_version || '1.0.0',
  };
}

module.exports = { prepareBackend };
