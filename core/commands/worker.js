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
const { resolveDeadline } = require('../deadlines');
const { writeJsonFileAtomic } = require('../fs-text');
const { persistCollectedResult, persistInitFiles, persistBackendEvents, persistFindings } = require('../result-artifact');
const { tryDisposeAdapter, classifyTerminalFailure, terminalExitCode } = require('./index');
const { persistStartedFact } = require('./attempt');
const { reduce, TERMINAL } = require('../reducer');
const { generateExecutionToken, workerIdentityDetail } = require('../process-identity');

// Must stay well under the reducer's 15s heartbeat-staleness threshold.
const HEARTBEAT_INTERVAL_MS = 5000;


async function main() {
  const stateRoot = process.env.DCLI_STATE_ROOT;
  const backendName = process.env.DCLI_BACKEND;
  const jobId = process.env.DCLI_JOB_ID;
  const repoKey = process.env.DCLI_REPO_KEY;
  const repoRoot = process.env.DCLI_REPO_ROOT;
  const hardTimeoutMsRaw = parseInt(process.env.DCLI_WORKER_HARD_TIMEOUT_MS || '0', 10);
  const queueClaimPath = process.env.DCLI_QUEUE_CLAIM_PATH || null;

  if (!stateRoot || !backendName || !jobId || !repoKey || !repoRoot) {
    console.error('Worker: missing required env vars');
    journalFailure(null, null, repoKey, jobId, stateRoot, 'worker_startup_failed', 'Missing required env vars');
    process.exit(1);
  }

  const { JobStore } = require('../job-store');
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
  const executionToken = params.executionToken || generateExecutionToken();

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
    const repoKey = entry.repoKey || 'unknown';
    const workerLogPath = path.join(stateRoot, 'jobs', repoKey, entry.jobId, 'attempts', '1', 'worker.log');
    const workerLog = fs.openSync(workerLogPath, 'a');
    const queuedExecutionToken = entry.executionToken || executionToken;
    let child;
    try {
      child = spawn(process.execPath, [workerPath], {
        detached: true, windowsHide: true,
        // A detached worker has no parent reader; retain output in its log.
        stdio: ['ignore', workerLog, workerLog],
        env: {
          ...process.env,
          DCLI_WORKER: '1',
          DCLI_STATE_ROOT: stateRoot,
          DCLI_BACKEND: entry.backend,
          DCLI_JOB_ID: entry.jobId,
          DCLI_REPO_KEY: repoKey,
          DCLI_REPO_ROOT: entry.repoRoot || stateRoot,
          DCLI_WORKER_HARD_TIMEOUT_MS: String(entry.hardTimeoutMs || 0),
          DCLI_QUEUE_CLAIM_PATH: entry.queueClaimPath || '',
        },
      });
    } finally {
      fs.closeSync(workerLog);
    }
    try {
      store.recordWorkerLaunch({
        jobId: entry.jobId, repoKey, attempt: 1, from: 'queued', pid: child.pid,
        executionToken: queuedExecutionToken,
      });
    } catch (err) {
      try { child.kill(); } catch {}
      throw err;
    }
    child.unref();
  });

  const slotResult = admission.acquireSlot(backendName);
  if (!slotResult.acquired) {
    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed',
      attempt: null,
      from: 'created',
      to: 'queued',
      detail: {
        phase: 'queued', queue_reason: slotResult.reason,
        worker_pid: null, worker_identity: null,
      },
    });
    if (queueClaimPath && fs.existsSync(queueClaimPath)) {
      try { fs.renameSync(queueClaimPath, path.join(stateRoot, 'queue', `${jobId}.json`)); } catch {}
    } else {
      admission.enqueueJob(backendName, jobId, {
        repoKey, repoRoot, hardTimeoutMs: hardTimeoutMsRaw > 0 ? hardTimeoutMsRaw : 0,
        executionToken,
      });
    }
    process.exit(0);
  }
  const slotId = slotResult.slotId;
  process.env.DCLI_SLOT_ID = slotId;
  if (queueClaimPath) {
    try { fs.unlinkSync(queueClaimPath); } catch {}
  }

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
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created',
    attempt: attemptNum,
    from: null,
    to: 'created',
    detail: { attempt_id: `attempt-${attemptNum}`, execution_token: executionToken },
  });

  // Journal running, carrying this worker's launch identity. Persisting it the
  // instant the process exists is what lets `cancel` kill something real and
  // reconciliation prove death; holding it only in the launcher's memory left
  // jobs stuck `running` and cancels that killed nothing (AGENTS.md #5).
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed',
    attempt: attemptNum,
    from: 'created',
    to: 'running',
    detail: {
      started_at: new Date().toISOString(),
      phase: 'agent_running',
      ...workerIdentityDetail(),
    },
  });

  // Heartbeat on a cadence, not once. The reducer treats a heartbeat older
  // than 15s as evidence the worker is gone, so a single startup heartbeat
  // makes every job that outlives 15s look lost.
  store.writeHeartbeat({ repoKey, jobId });
  const heartbeatTimer = setInterval(() => {
    try { store.writeHeartbeat({ repoKey, jobId }); } catch {}
  }, HEARTBEAT_INTERVAL_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  // Every terminal exit routes through here so the completion sentinel — the
  // evidence reconciliation reads to tell "finished" from "died" — cannot be
  // written on some paths and forgotten on others.
  //
  // `state` is recorded alongside the exit code because the two are not the
  // same claim. An `interrupted` attempt exits 0 by the CLI contract, and a
  // reader that only had the exit code turned that into `done` — a job that
  // was cut short read as a clean success. Written atomically: a half-written
  // sentinel is worse than none, because it looks like completion evidence.
  function finish(code, state) {
    clearInterval(heartbeatTimer);
    try {
      writeJsonFileAtomic(
        path.join(jobDir, 'attempts', String(attemptNum), 'worker-complete.json'),
        { exit_code: code, state: state || null, finished_at: new Date().toISOString() }
      );
    } catch {}
    process.exit(code);
  }

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
  // describes, so we record that the kill was skipped and why. Ticket 78 (contain the tree in
  // a Job Object at spawn time) is closed unimplemented; ADR-010 replaces it with a capability
  // ladder, and tickets 102/103 raise this site to a rung that can actually terminate a tree.
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
      finish(24, 'timed_out');
    }
    if (cancelled) {
      store.journalTransition(jobId, repoKey, {
        kind: 'attempt_state_changed',
        attempt: attemptNum,
        from: 'running',
        to: 'cancelled',
        detail: { finished_at: new Date().toISOString(), command_exit_code: null, phase: 'terminal' },
      });
      finish(0, 'cancelled');
    }
    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed',
      attempt: attemptNum,
      from: 'running',
      to: 'failed',
      detail: { finished_at: new Date().toISOString(), command_exit_code: null, phase: 'terminal', failure_reason: 'adapter_error', failure: err.message },
    });
    finish(1, 'failed');
  }

  // Observe with racing: each iteration is raced against the deadline so a
  // blocking Observe() call does not prevent the hard timeout from firing.
  const facts = [];
  try {
    for await (const fact of raceObserve(adapter.Observe(attempt), deadline)) {
      if (hardTimedOut || cancelled) throw null;
      facts.push(fact);
      persistStartedFact(store, repoKey, jobId, attemptNum, fact);

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
          finish(11, 'failed');
        }
        try { persistBackendEvents({ store, repoKey, jobId, attemptNum, facts }); } catch {}
        try { persistFindings({ store, repoKey, jobId, attemptNum, text: collected.text }); } catch {}

        const terminalFailure = classifyTerminalFailure({
          exitCode: fact.code !== undefined ? fact.code : null,
          resultBytes,
          reducerResult: result,
          resultStatus: collected.result_status,
        });
        // The classifier may override the state (a backend that exited 0 but
        // produced no result file is not `done`); the exit code must follow it.
        const effectiveState = terminalFailure.terminalState || terminalState;

        store.journalTransition(jobId, repoKey, {
          kind: 'attempt_state_changed',
          attempt: attemptNum,
          from: 'running',
          to: effectiveState,
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
        // Not 0: this code is what the completion sentinel records, and the
        // reducer reads a zero sentinel as `done`. A failed attempt exiting 0
        // here hands reconciliation evidence that contradicts the journal.
        finish(terminalExitCode(effectiveState, terminalFailure.failure, terminalFailure.failure_reason), effectiveState);
      }
    }
  } catch (err) {
    clearTimeout(hardTimeoutTimer);
    clearTimeout(cancelWatcherTimer);
    if (!hardTimedOut && err && err[HARD_TIMEOUT_ERROR]) hardTimedOut = true;
    await requestCancelRungs();
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
      finish(24, 'timed_out');
    }
    if (cancelled) {
      store.journalTransition(jobId, repoKey, {
        kind: 'attempt_state_changed',
        attempt: attemptNum,
        from: 'running',
        to: 'cancelled',
        detail: { finished_at: new Date().toISOString(), command_exit_code: null, phase: 'terminal' },
      });
      finish(0, 'cancelled');
    }
    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed',
      attempt: attemptNum,
      from: 'running',
      to: 'failed',
      detail: { finished_at: new Date().toISOString(), command_exit_code: null, phase: 'terminal', failure_reason: 'observe_error', failure: err.message },
    });
    finish(1, 'failed');
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
    finish(0, 'cancelled');
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
  // The exit code follows the reduced terminal state. It was inverted: a
  // `done` job exited 1 and an `interrupted` one exited 0 — and this code is
  // exactly what the completion sentinel records, so reconciliation read a
  // finished job as failed.
  finish(terminalExitCode(
    terminalState,
    result.failure,
    result.failure_reason || (terminalState === 'interrupted' ? 'observe_ended' : null)
  ), terminalState);
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
          let timer;
          try {
            const result = await Promise.race([
              iter.next().then(r => ({ value: r, source: 'iter' })),
              new Promise(resolve => {
                timer = setTimeout(() => resolve({ value: { done: true }, source: 'timer' }), remaining);
              }),
            ]);
            if (result.source === 'timer') {
              const err = new Error('Hard timeout reached');
              err[HARD_TIMEOUT_ERROR] = true;
              throw err;
            }
            return result.value;
          } finally {
            if (timer) clearTimeout(timer);
          }
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

function writeCrashSentinel(stateRoot, repoKey, jobId, code, state) {
  try {
    const jobDir = path.join(stateRoot, 'jobs', repoKey, jobId);
    writeJsonFileAtomic(
      path.join(jobDir, 'attempts', '1', 'worker-complete.json'),
      { exit_code: code, state, finished_at: new Date().toISOString() }
    );
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
  writeCrashSentinel(
    process.env.DCLI_STATE_ROOT,
    process.env.DCLI_REPO_KEY,
    process.env.DCLI_JOB_ID,
    1,
    'failed'
  );
  try {
    const { AdmissionController } = require('../admission');
    const { getBackendLimits } = require('../../adapters/registry');
    const admission = new AdmissionController({
      stateRoot: process.env.DCLI_STATE_ROOT,
      backendLimits: getBackendLimits(),
    });
    admission.releaseSlot(process.env.DCLI_SLOT_ID);
  } catch {}
  process.exit(1);
});
