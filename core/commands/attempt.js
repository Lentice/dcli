const { isVersionInRange } = require('./index');
const { DEFAULT_BACKEND } = require('../../adapters/registry');
const { removeWorktree } = require('../worktree');

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

/**
 * Release the resources a run/resume command acquired before the handoff to
 * driveAttempt(). Called only on setup failure: after a successful handoff,
 * driveAttempt owns the worktree and slot and finalizes both itself. Track
 * worktreeCreated rather than worktreePath alone: createDetachedWorktree
 * throws "path already exists" for a pre-existing directory, and calling
 * removeWorktree for it would delete a directory setup never created.
 *
 * @param {Object}   a
 * @param {string}   a.repoRoot
 * @param {string|null} a.worktreePath
 * @param {boolean}  a.worktreeCreated
 * @param {Object|null} a.admission
 * @param {string|null} a.acquiredSlotId
 */
function releaseSetupResources({ repoRoot, worktreePath = null, worktreeCreated = false, admission = null, acquiredSlotId = null }) {
  if (worktreeCreated && worktreePath) removeWorktree(repoRoot, worktreePath);
  if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
}

module.exports = { prepareBackend, releaseSetupResources };
