// Detached worker process for background job execution.
// Spawned by submit command. Reads job params from the job directory
// and runs the adapter to completion, journaling all transitions.
//
// Environment:
//   DCLI_WORKER=1
//   DCLI_STATE_ROOT=<path>
//   DCLI_BACKEND=<name>
//   DCLI_JOB_ID=<id>
//   DCLI_REPO_KEY=<key>
//   DCLI_REPO_ROOT=<path>
//   DCLI_WORKER_HARD_TIMEOUT_MS=<ms>

if (process.env.DCLI_WORKER !== '1') {
  console.error('worker.js requires DCLI_WORKER=1');
  process.exit(1);
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { persistCollectedResult, persistInitFiles, persistBackendEvents, persistFindings } = require('../result-artifact');
const { tryDisposeAdapter } = require('./index');

const TERMINAL = new Set(['done', 'failed', 'timed_out', 'cancelled', 'interrupted']);

async function main() {
  const stateRoot = process.env.DCLI_STATE_ROOT;
  const backendName = process.env.DCLI_BACKEND;
  const jobId = process.env.DCLI_JOB_ID;
  const repoKey = process.env.DCLI_REPO_KEY;
  const repoRoot = process.env.DCLI_REPO_ROOT;
  const hardTimeoutMs = parseInt(process.env.DCLI_WORKER_HARD_TIMEOUT_MS || '0', 10);

  if (!stateRoot || !backendName || !jobId || !repoKey || !repoRoot) {
    console.error('Worker: missing required env vars');
    journalFailure(null, null, repoKey, jobId, stateRoot, 'worker_startup_failed', 'Missing required env vars');
    process.exit(1);
  }

  const { JobStore } = require('../job-store');
  const { buildEnvelope } = require('./index');
  const { AdmissionController } = require('../admission');
  const store = new JobStore({ stateRoot });

  const jobDir = store.getJobDir(repoKey, jobId);

  // Read params
  let params;
  try {
    params = JSON.parse(fs.readFileSync(path.join(jobDir, 'params.json'), 'utf8'));
  } catch (err) {
    journalFailure(store, null, repoKey, jobId, null, 'worker_startup_failed', `Cannot read params: ${err.message}`);
    process.exit(1);
  }

  // Read prompt
  let prompt;
  try {
    prompt = fs.readFileSync(path.join(jobDir, 'prompt.txt'), 'utf8');
  } catch (err) {
    journalFailure(store, null, repoKey, jobId, null, 'worker_startup_failed', `Cannot read prompt: ${err.message}`);
    process.exit(1);
  }

  // Acquire admission slot
  const admission = new AdmissionController({ stateRoot, backendLimits: { opencode: 3, codex: 3, claude: 3 } });
  admission.reconcile();
  const slotResult = admission.acquireSlot(backendName);
  if (!slotResult.acquired) {
    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed',
      attempt: null,
      from: 'created',
      to: 'queued',
      detail: { phase: 'queued', queue_reason: slotResult.reason },
    });
    admission.enqueueJob(backendName, jobId);
    process.exit(0);
  }
  const slotId = slotResult.slotId;

  // Load adapter
  let adapter;
  try {
    const adapterPath = path.resolve(__dirname, '..', '..', 'adapters', backendName, 'adapter');
    const mod = require(adapterPath);
    const adapterConfig = params._adapterScript || {};
    const AdapterClass = mod.ClaudeAdapter || mod.CodexAdapter || mod.OpencodeAdapter || mod.FakeAdapter || mod[Object.keys(mod)[0]];
    adapter = new AdapterClass(adapterConfig);
  } catch (err) {
    journalFailure(store, slotId, repoKey, jobId, null, 'worker_startup_failed', `Cannot load adapter: ${err.message}`);
    admission.releaseSlot(slotId);
    process.exit(1);
  }

  // Validate
  try {
    adapter.ValidateRequest({
      model: params.model || null,
      canonicalDir: repoRoot,
      reasoningEffort: params.reasoningEffort || null,
      variant: params.variant || null,
      effort: params.effort || null,
      access: params.access || 'read-only',
    });
    adapter.DetectVersion();
  } catch (err) {
    journalFailure(store, slotId, repoKey, jobId, null, 'validation_failed', err.message);
    admission.releaseSlot(slotId);
    process.exit(2);
  }

  // Create attempt dir
  const attemptNum = 1;
  try {
    store.createAttemptDir({ repoKey, jobId, attemptNum });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      journalFailure(store, slotId, repoKey, jobId, null, 'worker_startup_failed', `Cannot create attempt dir: ${err.message}`);
      admission.releaseSlot(slotId);
      process.exit(1);
    }
  }

  // Write initial attempt files
  persistInitFiles({
    store, repoKey, jobId, attemptNum, prompt,
    commandParams: {
      model: params.model || null,
      access: params.access || 'read-only',
      mode: params.mode || 'run',
      hardTimeoutMs: params.hardTimeoutMs || 0,
      reasoningEffort: params.reasoningEffort || null,
      variant: params.variant || null,
      effort: params.effort || null,
    },
  });

  // Journal attempt_created
  const executionToken = 'tok-' + crypto.randomBytes(16).toString('hex');
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created',
    attempt: attemptNum,
    from: null,
    to: 'created',
    detail: { attempt_id: `attempt-${attemptNum}`, execution_token: executionToken },
  });

  // Journal running
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed',
    attempt: attemptNum,
    from: 'created',
    to: 'running',
    detail: { started_at: new Date().toISOString(), phase: 'agent_running' },
  });

  // Write first heartbeat
  store.writeHeartbeat({ repoKey, jobId });

  // Hard timeout
  let hardTimedOut = false;
  let hardTimeoutTimer = null;
  if (hardTimeoutMs > 0) {
    hardTimeoutTimer = setTimeout(() => {
      hardTimedOut = true;
      try {
        const rungs = adapter.DeclareCancelRungs();
        if (rungs && rungs.length > 0) {
          for (const rung of rungs) {
            try { adapter.RequestCancel({}, rung); } catch {}
          }
        }
      } catch {}
    }, hardTimeoutMs);
    if (hardTimeoutTimer.unref) hardTimeoutTimer.unref();
  }

  // Run the job
  const attempt = {};

  try {
    adapter.PrepareInvocation(attempt, params);
    await adapter.Start(attempt);
    if (hardTimedOut) throw null;
    await adapter.SendPrompt(attempt, prompt);
    if (hardTimedOut) throw null;
  } catch (err) {
    clearTimeout(hardTimeoutTimer);
    tryDisposeAdapter(adapter, attempt);
    admission.releaseSlot(slotId);
    if (hardTimedOut) {
      store.journalTransition(jobId, repoKey, {
        kind: 'attempt_state_changed',
        attempt: attemptNum,
        from: 'running',
        to: 'timed_out',
        detail: { finished_at: new Date().toISOString(), command_exit_code: null, phase: 'terminal', failure_reason: 'hard_timeout' },
      });
      process.exit(24);
    }
    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed',
      attempt: attemptNum,
      from: 'running',
      to: 'failed',
      detail: { finished_at: new Date().toISOString(), command_exit_code: null, phase: 'terminal', failure_reason: 'adapter_error', failure: err.message },
    });
    process.exit(1);
  }

  const facts = [];
  try {
    for await (const fact of adapter.Observe(attempt)) {
      if (hardTimedOut) throw null;
      facts.push(fact);

      if (fact.type === 'process_exited') {
        clearTimeout(hardTimeoutTimer);
        const collected = adapter.CollectResult(attempt);
        const terminalState = fact.code === 0 ? 'done' : 'failed';
        let resultBytes;
        try {
          resultBytes = persistCollectedResult({ store, repoKey, jobId, attemptNum, collected });
        } catch {
          store.journalTransition(jobId, repoKey, {
            kind: 'attempt_state_changed',
            attempt: attemptNum,
            from: 'running',
            to: 'failed',
            detail: {
              finished_at: new Date().toISOString(),
              command_exit_code: fact.code !== undefined ? fact.code : null,
              phase: 'terminal',
              failure_reason: 'result_persistence_failed',
              failure: { class: 'artifact_persistence', message: 'Unable to persist result artifact' },
            },
          });
          tryDisposeAdapter(adapter, attempt);
          admission.releaseSlot(slotId);
          process.exit(11);
        }
        try { persistBackendEvents({ store, repoKey, jobId, attemptNum, facts }); } catch {}
        try { persistFindings({ store, repoKey, jobId, attemptNum, text: collected.text }); } catch {}

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
            result_bytes: resultBytes,
          },
        });

        tryDisposeAdapter(adapter, attempt);
        admission.releaseSlot(slotId);
        process.exit(0);
      }
    }
  } catch (err) {
    clearTimeout(hardTimeoutTimer);
    tryDisposeAdapter(adapter, attempt);
    admission.releaseSlot(slotId);
    if (hardTimedOut) {
      store.journalTransition(jobId, repoKey, {
        kind: 'attempt_state_changed',
        attempt: attemptNum,
        from: 'running',
        to: 'timed_out',
        detail: { finished_at: new Date().toISOString(), command_exit_code: null, phase: 'terminal', failure_reason: 'hard_timeout' },
      });
      process.exit(24);
    }
    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed',
      attempt: attemptNum,
      from: 'running',
      to: 'failed',
      detail: { finished_at: new Date().toISOString(), command_exit_code: null, phase: 'terminal', failure_reason: 'observe_error', failure: err.message },
    });
    process.exit(1);
  }

  clearTimeout(hardTimeoutTimer);

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
      ...(collected.backend_session_id ? { backend_session_id: collected.backend_session_id } : {}),
      ...(collected.usage ? { tokens: collected.usage } : {}),
    },
  });
  tryDisposeAdapter(adapter, attempt);
  admission.releaseSlot(slotId);
  process.exit(1);
}

function journalFailure(store, slotId, repoKey, jobId, stateRoot, reason, message) {
  try {
    if (!store && stateRoot) {
      const { JobStore } = require('../job-store');
      store = new JobStore({ stateRoot });
    }
    if (store && repoKey && jobId) {
      store.journalTransition(jobId, repoKey, {
        kind: 'attempt_state_changed',
        attempt: 1,
        from: 'created',
        to: 'failed',
        detail: { finished_at: new Date().toISOString(), phase: 'terminal', failure_reason: reason, failure: message },
      });
    }
  } catch {}
}

main().catch(err => {
  console.error('Worker fatal:', err.message);
  try {
    const s = new (require('../job-store').JobStore)({ stateRoot: process.env.DCLI_STATE_ROOT });
    s.journalTransition(process.env.DCLI_JOB_ID, process.env.DCLI_REPO_KEY, {
      kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'failed',
      detail: { finished_at: new Date().toISOString(), phase: 'terminal', failure_reason: 'worker_crash', failure: err.message },
    });
  } catch {}
  process.exit(1);
});
