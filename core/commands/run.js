const crypto = require('crypto');
const { generateJobId } = require('../job-id');
const { reduce } = require('../reducer');
const { buildEnvelope, isVersionInRange } = require('./index');

const TERMINAL = new Set(['done', 'failed', 'timed_out', 'cancelled', 'interrupted']);

async function executeRun({ store, adapter, repoKey, repoRoot, prompt, hardTimeoutSec, group, label, model, reasoningEffort, variant, effort, admission }) {
  const jobId = generateJobId();
  const now = new Date();
  const isoNow = now.toISOString();
  let acquiredSlotId = null;

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

  const identity = adapter.GetIdentity();
  const backend = identity.backend || 'fake';
  const backendVersion = detectedVersion || '1.0.0';
  const adapterVersion = identity.adapter_version || '1.0.0';
  if (admission) {
    const result = admission.acquireSlot(backend);
    if (!result.acquired) {
      const err = new Error(`System at capacity (global: ${result.active}/${result.limit}). Try again later or use "submit" instead.`);
      err.exitCode = 14;
      throw err;
    }
    acquiredSlotId = result.slotId;
  }

  store.createJob({
    jobId, repoKey, repoRoot,
    backend,
    backendVersion,
    adapterVersion,
    mode: 'run',
    access: 'read-only',
    group, label, model,
    hardTimeoutSec,
    capabilitiesSnapshot,
  });

  const attemptNum = 1;
  store.createAttemptDir({ repoKey, jobId, attemptNum });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created',
    attempt: attemptNum,
    from: null,
    to: 'created',
    detail: { attempt_id: `attempt-${attemptNum}`, execution_token: 'tok-' + crypto.randomBytes(16).toString('hex') },
  });

  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed',
    attempt: attemptNum,
    from: 'created',
    to: 'running',
    detail: { started_at: isoNow, phase: 'agent_running' },
  });

  const attempt = {};
  try {
    await adapter.Start(attempt);
    await adapter.SendPrompt(attempt, prompt);
  } catch (err) {
    if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
    throw err;
  }

  const facts = [];
  try {
    for await (const fact of adapter.Observe(attempt)) {
      facts.push(fact);

      if (fact.type === 'process_exited') {
        const status = store.regenerateStatus({ repoKey, jobId });
        const result = reduce(status, facts, {});
        const collected = adapter.CollectResult(attempt);
        const terminalState = result.state;

        store.journalTransition(jobId, repoKey, {
          kind: 'attempt_state_changed',
          attempt: attemptNum,
          from: 'running',
          to: terminalState,
          detail: {
            finished_at: new Date().toISOString(),
            command_exit_code: fact.code !== undefined ? fact.code : null,
            phase: 'terminal',
            ...(collected.backend_session_id ? { backend_session_id: collected.backend_session_id } : {}),
            ...(collected.usage ? { tokens: collected.usage } : {}),
          },
        });

        if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
        const finalStatus = store.readStatus({ repoKey, jobId });
        return { text: collected.text, jobId, envelope: buildEnvelope(finalStatus) };
      }
    }
  } catch (err) {
    if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
    throw err;
  }

  const collected = adapter.CollectResult(attempt);
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed',
    attempt: attemptNum,
    from: 'running',
    to: 'failed',
    detail: {
      finished_at: new Date().toISOString(),
      command_exit_code: 1,
      phase: 'terminal',
    },
  });

  if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
  const finalStatus = store.readStatus({ repoKey, jobId });
  return { text: collected.text, jobId, envelope: buildEnvelope(finalStatus), exitCode: 1 };
}

module.exports = { executeRun };
