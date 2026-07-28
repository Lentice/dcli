const { generateJobId } = require('../job-id');
const { reduce } = require('../reducer');
const { buildEnvelope } = require('./index');

const TERMINAL = new Set(['done', 'failed', 'timed_out', 'cancelled', 'interrupted']);

async function executeRun({ store, adapter, repoKey, repoRoot, prompt, hardTimeoutSec, group, label, model, reasoningEffort, variant, effort }) {
  const jobId = generateJobId();
  const now = new Date();
  const isoNow = now.toISOString();

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
    detail: { attempt_id: `attempt-${attemptNum}`, execution_token: 'tok-fake' },
  });

  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed',
    attempt: attemptNum,
    from: 'created',
    to: 'running',
    detail: { started_at: isoNow, phase: 'agent_running' },
  });

  const attempt = {};
  adapter.Start(attempt);
  adapter.SendPrompt(attempt, prompt);

  const facts = [];
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

      const finalStatus = store.readStatus({ repoKey, jobId });
      return { text: collected.text, jobId, envelope: buildEnvelope(finalStatus) };
    }
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

  const finalStatus = store.readStatus({ repoKey, jobId });
  return { text: collected.text, jobId, envelope: buildEnvelope(finalStatus), exitCode: 1 };
}

module.exports = { executeRun };
