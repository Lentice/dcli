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
const { resolveDeadline } = require('../deadlines');
const { persistCollectedResult, persistInitFiles, persistBackendEvents, persistFindings } = require('../result-artifact');
const { tryDisposeAdapter, classifyTerminalFailure } = require('./index');
const { reduce } = require('../reducer');

const TERMINAL = new Set(['done', 'failed', 'timed_out', 'cancelled', 'interrupted']);

async function main() {
  const stateRoot = process.env.DCLI_STATE_ROOT;
  const backendName = process.env.DCLI_BACKEND;
  const jobId = process.env.DCLI_JOB_ID;
  const repoKey = process.env.DCLI_REPO_KEY;
  const repoRoot = process.env.DCLI_REPO_ROOT;
  const hardTimeoutMsRaw = parseInt(process.env.DCLI_WORKER_HARD_TIMEOUT_MS || '0', 10);

  if (!stateRoot || !backendName || !jobId || !repoKey || !repoRoot) {
    console.error('Worker: missing required env vars');
    journalFailure(null, null, repoKey, jobId, stateRoot, 'worker_startup_failed', 'Missing required env vars');
    process.exit(1);
  }

  const { JobStore } = require('../job-store');
  const { buildEnvelope } = require('./index');
  const { AdmissionController } = require('../admission');
  const { getBackendLimits } = require('../../adapters/registry');
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
  const admission = new AdmissionController({ stateRoot, backendLimits: getBackendLimits() });
  admission.reconcile();

  // Set up dequeue spawning so queued jobs are re-launched when slots free
  admission.setSpawnWorker((entry) => {
    const { spawn } = require('child_process');
    const workerPath = path.resolve(__dirname, 'worker.js');
    const child = spawn(process.execPath, [workerPath], {
      detached: true, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DCLI_WORKER: '1',
        DCLI_STATE_ROOT: stateRoot,
        DCLI_BACKEND: entry.backend,
        DCLI_JOB_ID: entry.jobId,
        DCLI_REPO_KEY: entry.repoKey || 'unknown',
        DCLI_REPO_ROOT: entry.repoRoot || stateRoot,
        DCLI_WORKER_HARD_TIMEOUT_MS: String(entry.hardTimeoutMs || 0),
      },
    });
    child.unref();
  });

  const slotResult = admission.acquireSlot(backendName);
  if (!slotResult.acquired) {
    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed',
      attempt: null,
      from: 'created',
      to: 'queued',
      detail: { phase: 'queued', queue_reason: slotResult.reason },
    });
    admission.enqueueJob(backendName, jobId, {
      repoKey, repoRoot, hardTimeoutMs,
    });
    process.exit(0);
  }
  const slotId = slotResult.slotId;

  // Load adapter
  let adapter;
  try {
    const adapterPath = path.resolve(__dirname, '..', '..', 'adapters', backendName, 'adapter');
    const { getBackground } = require('../../adapters/registry');
    const bg = getBackground(backendName);
    const mod = require(adapterPath);
    const adapterConfig = params._adapterScript || {};
    const AdapterClass = mod[bg.class];
    if (!AdapterClass) throw new Error(`Adapter module for "${backendName}" does not export class ${bg.class}`);
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

  // Apply default hard timeout when none specified (invariant #3: nothing blocks forever).
  // 0 means "not supplied" and gets the default. Validate before use (mistake #6).
  const hardTimeoutMs = resolveDeadline('JOB_HARD_TIMEOUT_MS',
    hardTimeoutMsRaw > 0 ? hardTimeoutMsRaw : undefined);

  // Hard timeout setup: deadline-based so an adapter blocked inside a single long
  // Observe() call is still interrupted via Promise.race in raceObserve() below.
  const deadline = Date.now() + hardTimeoutMs;
  let hardTimedOut = false;
  let hardTimeoutTimer = null;
  /** @type {string|null} why no contained tree kill happened on hard timeout */
  let hardTimeoutKillSkipped = null;

  const attempt = {};

  async function requestCancelRungs() {
    try {
      const rungs = adapter.DeclareCancelRungs();
      if (rungs && rungs.length > 0) {
        for (const rung of rungs) {
          try { await adapter.RequestCancel(attempt, rung); } catch {}
        }
      }
    } catch {}
  }

  // Why the hard timeout cannot escalate past the rung walk yet: the adapter spawns the
  // backend with a plain `spawn`, so the tree is not inside a Job Object, and the native
  // helper can only terminate a Job Object it created itself (see core/containment.js).
  // Recording an escalation we did not perform is the failure mode AGENTS.md Mistake #5
  // describes, so we record that the kill was skipped and why. Ticket 78 removes the
  // limitation by containing the tree at spawn time; then this becomes context.terminate().
  hardTimeoutTimer = setTimeout(async () => {
    hardTimedOut = true;
    await requestCancelRungs();
    hardTimeoutKillSkipped = 'not_contained';
  }, hardTimeoutMs);
  if (hardTimeoutTimer.unref) hardTimeoutTimer.unref();

  // Cancel request watcher: observe cancel.request on a bounded cadence
  let cancelled = false;
  let cancelWatcherTimer = null;
  const CANCEL_WATCH_MS = 2000;

  async function checkCancelRequest() {
    if (cancelled || hardTimedOut) return;
    try {
      const cancelPath = path.join(jobDir, 'cancel.request');
      if (fs.existsSync(cancelPath)) {
        cancelled = true;
        clearTimeout(cancelWatcherTimer);
        await requestCancelRungs();
      }
    } catch {}
    if (!cancelled && !hardTimedOut) {
      cancelWatcherTimer = setTimeout(checkCancelRequest, CANCEL_WATCH_MS);
      if (cancelWatcherTimer.unref) cancelWatcherTimer.unref();
    }
  }
  cancelWatcherTimer = setTimeout(checkCancelRequest, CANCEL_WATCH_MS);
  if (cancelWatcherTimer.unref) cancelWatcherTimer.unref();

  // Run the job
  try {
    adapter.PrepareInvocation(attempt, params);
    await adapter.Start(attempt);
    if (hardTimedOut || cancelled) throw null;
    await adapter.SendPrompt(attempt, prompt);
    if (hardTimedOut || cancelled) throw null;
  } catch (err) {
    clearTimeout(hardTimeoutTimer);
    clearTimeout(cancelWatcherTimer);
    await tryDisposeAdapter(adapter, attempt);
    admission.releaseSlot(slotId);
    if (hardTimedOut) {
      store.journalTransition(jobId, repoKey, {
        kind: 'attempt_state_changed',
        attempt: attemptNum,
        from: 'running',
        to: 'timed_out',
        detail: { finished_at: new Date().toISOString(), command_exit_code: null, phase: 'terminal', failure_reason: 'hard_timeout', kill_skipped: hardTimeoutKillSkipped },
      });
      process.exit(24);
    }
    if (cancelled) {
      store.journalTransition(jobId, repoKey, {
        kind: 'attempt_state_changed',
        attempt: attemptNum,
        from: 'running',
        to: 'cancelled',
        detail: { finished_at: new Date().toISOString(), command_exit_code: null, phase: 'terminal' },
      });
      process.exit(0);
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

  // Observe with racing: each iteration is raced against the deadline so a
  // blocking Observe() call does not prevent the hard timeout from firing.
  const facts = [];
  try {
    for await (const fact of raceObserve(adapter.Observe(attempt), deadline)) {
      if (hardTimedOut || cancelled) throw null;
      facts.push(fact);

      if (fact.type === 'process_exited') {
        clearTimeout(hardTimeoutTimer);
        clearTimeout(cancelWatcherTimer);
        // If cancelled by external request, don't report process_exited as done
        if (cancelled && !hardTimedOut) throw null;
        const status = store.regenerateStatus({ repoKey, jobId });
        const result = reduce(status, facts, {});
        const collected = adapter.CollectResult(attempt);
        const terminalState = result.state;
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
          await tryDisposeAdapter(adapter, attempt);
          admission.releaseSlot(slotId);
          process.exit(11);
        }
        try { persistBackendEvents({ store, repoKey, jobId, attemptNum, facts }); } catch {}
        try { persistFindings({ store, repoKey, jobId, attemptNum, text: collected.text }); } catch {}

        const terminalFailure = classifyTerminalFailure({
          exitCode: fact.code !== undefined ? fact.code : null,
          resultBytes,
          reducerResult: result,
        });

        store.journalTransition(jobId, repoKey, {
          kind: 'attempt_state_changed',
          attempt: attemptNum,
          from: 'running',
          to: terminalState,
          detail: {
            finished_at: new Date().toISOString(),
            command_exit_code: fact.code !== undefined ? fact.code : null,
            phase: 'terminal',
            failure_reason: terminalFailure.failure_reason,
            failure: terminalFailure.failure,
            ...(collected.backend_session_id ? { backend_session_id: collected.backend_session_id } : {}),
            ...(collected.usage ? { tokens: collected.usage } : {}),
            result_bytes: resultBytes,
          },
        });

        await tryDisposeAdapter(adapter, attempt);
        admission.releaseSlot(slotId);
        process.exit(0);
      }
    }
  } catch (err) {
    clearTimeout(hardTimeoutTimer);
    clearTimeout(cancelWatcherTimer);
    if (!hardTimedOut && err && err[HARD_TIMEOUT_ERROR]) hardTimedOut = true;
    requestCancelRungs();
    // Collect partial result before dispose so adapter state is intact
    let partialResult = null;
    try { partialResult = adapter.CollectResult(attempt); } catch {}
    await tryDisposeAdapter(adapter, attempt);
    admission.releaseSlot(slotId);
    if (hardTimedOut) {
      // Flush partial output before journaling timed_out
      if (partialResult && partialResult.text) {
        try { persistCollectedResult({ store, repoKey, jobId, attemptNum, collected: partialResult }); } catch {}
        try { persistFindings({ store, repoKey, jobId, attemptNum, text: partialResult.text }); } catch {}
      }
      try { persistBackendEvents({ store, repoKey, jobId, attemptNum, facts }); } catch {}
      store.journalTransition(jobId, repoKey, {
        kind: 'attempt_state_changed',
        attempt: attemptNum,
        from: 'running',
        to: 'timed_out',
        detail: { finished_at: new Date().toISOString(), command_exit_code: null, phase: 'terminal', failure_reason: 'hard_timeout', kill_skipped: hardTimeoutKillSkipped },
      });
      process.exit(24);
    }
    if (cancelled) {
      store.journalTransition(jobId, repoKey, {
        kind: 'attempt_state_changed',
        attempt: attemptNum,
        from: 'running',
        to: 'cancelled',
        detail: { finished_at: new Date().toISOString(), command_exit_code: null, phase: 'terminal' },
      });
      process.exit(0);
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
  clearTimeout(cancelWatcherTimer);

  if (cancelled) {
    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed',
      attempt: attemptNum,
      from: 'running',
      to: 'cancelled',
      detail: { finished_at: new Date().toISOString(), command_exit_code: null, phase: 'terminal' },
    });
    await tryDisposeAdapter(adapter, attempt);
    admission.releaseSlot(slotId);
    process.exit(0);
  }

  const collected = adapter.CollectResult(attempt);
  const status = store.regenerateStatus({ repoKey, jobId });
  const result = reduce(status, facts, {});
  let resultBytes = null;
  try { resultBytes = persistCollectedResult({ store, repoKey, jobId, attemptNum, collected }); } catch {}
  try { persistBackendEvents({ store, repoKey, jobId, attemptNum, facts }); } catch {}
  try { persistFindings({ store, repoKey, jobId, attemptNum, text: collected.text }); } catch {}

  const terminalState = TERMINAL.has(result.state) ? result.state : 'interrupted';

  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed',
    attempt: attemptNum,
    from: 'running',
    to: terminalState,
    detail: {
      finished_at: new Date().toISOString(),
      command_exit_code: result.command_exit_code !== undefined ? result.command_exit_code : null,
      phase: 'terminal',
      failure_reason: result.failure_reason || (terminalState === 'interrupted' ? 'observe_ended' : null),
      failure: result.failure || null,
      ...(collected.backend_session_id ? { backend_session_id: collected.backend_session_id } : {}),
      ...(collected.usage ? { tokens: collected.usage } : {}),
      result_bytes: resultBytes,
    },
  });
  await tryDisposeAdapter(adapter, attempt);
  admission.releaseSlot(slotId);
  process.exit(terminalState === 'interrupted' ? 0 : 1);
}

const HARD_TIMEOUT_ERROR = Symbol('hard_timeout');

function raceObserve(iterator, deadline) {
  return {
    [Symbol.asyncIterator]() {
      const iter = iterator[Symbol.asyncIterator]();
      return {
        async next() {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            const err = new Error('Hard timeout reached');
            err[HARD_TIMEOUT_ERROR] = true;
            throw err;
          }
          const result = await Promise.race([
            iter.next().then(r => ({ value: r, source: 'iter' })),
            new Promise(resolve => setTimeout(() => resolve({ value: { done: true }, source: 'timer' }), remaining)),
          ]);
          if (result.source === 'timer') {
            const err = new Error('Hard timeout reached');
            err[HARD_TIMEOUT_ERROR] = true;
            throw err;
          }
          return result.value;
        },
        async return() {
          if (typeof iter.return === 'function') {
            return iter.return();
          }
          return { done: true };
        },
        async throw(err) {
          if (typeof iter.throw === 'function') {
            return iter.throw(err);
          }
          throw err;
        },
      };
    },
  };
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
