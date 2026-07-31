const path = require('path');
const { spawn } = require('child_process');
const { DEFAULT_BACKEND } = require('../../adapters/registry');
const { generateJobId } = require('../job-id');
const { buildEnvelope, isVersionInRange } = require('./index');
const { writeTextFileAtomic, writeJsonFileAtomic } = require('../fs-text');
const { persistInitFiles } = require('../result-artifact');

function executeSubmit({ store, adapter, repoKey, repoRoot, prompt, hardTimeoutSec, group, label, model, access, reasoningEffort, variant, effort, admission, resumeJobId, stateRoot, backend }) {
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
  const resolvedBackend = identity.backend || DEFAULT_BACKEND;
  const backendVersion = detectedVersion || '1.0.0';
  const adapterVersion = identity.adapter_version || '1.0.0';
  const effectiveAccess = access || 'read-only';

  const inheritedGroup = group || (parentStatus ? parentStatus.group : null);
  const inheritedLabel = label || (parentStatus ? parentStatus.label : null);
  const inheritedAccess = access || (parentStatus ? parentStatus.access : null) || 'read-only';

  store.createJob({
    jobId, repoKey, repoRoot,
    backend: resolvedBackend,
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

  // Persist prompt and run params to the job directory for the worker
  const jobDir = store.getJobDir(repoKey, jobId);
  writeTextFileAtomic(path.join(jobDir, 'prompt.txt'), prompt);
  writeJsonFileAtomic(path.join(jobDir, 'params.json'), {
    canonicalDir: repoRoot,
    model,
    access: inheritedAccess,
    reasoningEffort: reasoningEffort || null,
    variant: variant || null,
    effort: effort || null,
    mode: 'run',
    hardTimeoutMs: hardTimeoutSec && hardTimeoutSec > 0 ? hardTimeoutSec * 1000 : 0,
    _adapterScript: adapter.script || null,
  });

  // Also write prompt.md and command.json to the attempt directory
  const attemptNum = 1;
  try {
    store.createAttemptDir({ repoKey, jobId, attemptNum });
  } catch {
    // Attempt dir may already exist from a previous submit — safe to ignore
  }
  persistInitFiles({
    store, repoKey, jobId, attemptNum, prompt,
    commandParams: {
      model,
      access: inheritedAccess,
      mode: 'run',
      hardTimeoutMs: hardTimeoutSec && hardTimeoutSec > 0 ? hardTimeoutSec * 1000 : 0,
      reasoningEffort: reasoningEffort || null,
      variant: variant || null,
      effort: effort || null,
    },
  });

  // Spawn detached worker (admission slot acquired by the worker itself)
  spawnWorker({ stateRoot, backend: backend || resolvedBackend, jobId, repoKey, repoRoot, hardTimeoutSec });

  return { jobId };
}

function spawnWorker({ stateRoot, backend, jobId, repoKey, repoRoot, hardTimeoutSec }) {
  const workerScript = path.resolve(__dirname, 'worker.js');
  const hardTimeoutMs = hardTimeoutSec && hardTimeoutSec > 0 ? hardTimeoutSec * 1000 : 0;

  const child = spawn(process.execPath, [workerScript], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DCLI_WORKER: '1',
      DCLI_STATE_ROOT: stateRoot,
      DCLI_BACKEND: backend,
      DCLI_JOB_ID: jobId,
      DCLI_REPO_KEY: repoKey,
      DCLI_REPO_ROOT: repoRoot,
      DCLI_WORKER_HARD_TIMEOUT_MS: String(hardTimeoutMs),
    },
  });

  // Allow parent to exit independently
  child.unref();

  // Bound the process-creation call itself: re-snapshot identity if still
  // available, but do not wait for the child. If spawn fails, journal the
  // failure synchronously.
  child.on('error', (err) => {
    try {
      const { JobStore } = require('../job-store');
      const store = new JobStore({ stateRoot });
      store.journalTransition(jobId, repoKey, {
        kind: 'attempt_state_changed',
        attempt: 1,
        from: 'created',
        to: 'failed',
        detail: {
          finished_at: new Date().toISOString(),
          phase: 'terminal',
          failure_reason: 'worker_spawn_failed',
          failure: err.message,
        },
      });
    } catch {}
  });
}

module.exports = { executeSubmit };
