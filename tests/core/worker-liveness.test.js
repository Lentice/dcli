// @suite full
// @serial  spawns a real worker and kills it
//
// The recovery path had no coverage because none of its evidence was ever
// produced: nothing persisted worker_pid, nothing wrote the completion
// sentinel, nothing heartbeat past startup, and nothing called
// reconcileStatus(). Each half looked implemented on its own, so a killed
// worker left the job `running` forever and `wait` polled to its budget.
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const { JobStore } = require('../../core/job-store');
const { loadJobOrThrow } = require('../../core/job-lookup');
const { reduce } = require('../../core/reducer');
const { cancelJob } = require('../../core/cancel');
const { isSameProcessAlive } = require('../../core/process-identity');
const { AdmissionController } = require('../../core/admission');
const { FakeAdapter } = require('../../adapters/fake/adapter');

const REPO_KEY = 'test';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-liveness-test-'));
}

// Never leave a hang-shaped fixture alive: a leaked process poisons every
// later test on the machine, and the finally block runs on assertion failure
// too — which is exactly when it matters.
// Must be async and must await the 'exit' event: a synchronous Atomics.wait
// spin blocks the event loop, so the exit is never delivered and the child
// looks alive no matter how long we spin.
function killAndVerify(child) {
  if (!child) return Promise.resolve();
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new assert.AssertionError({
        message: `fixture pid ${child.pid} survived teardown`,
        actual: false, expected: true, operator: '==',
      }));
    }, 15000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.once('error', () => { clearTimeout(timer); resolve(); });
    try { child.kill('SIGKILL'); } catch { clearTimeout(timer); resolve(); }
  });
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function seedRunningJob(store, jobId, runningDetail, { hardTimeoutSec = null } = {}) {
  store.createJob({
    jobId, repoKey: REPO_KEY, repoRoot: process.cwd(),
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'submit', access: 'read-only',
    hardTimeoutSec,
  });
  store.createAttemptDir({ repoKey: REPO_KEY, jobId, attemptNum: 1 });
  store.journalTransition(jobId, REPO_KEY, {
    kind: 'attempt_created', attempt: 1, from: null, to: 'created',
    detail: { attempt_id: 'attempt-1', execution_token: 'tok-test' },
  });
  store.journalTransition(jobId, REPO_KEY, {
    kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'running',
    detail: { started_at: new Date().toISOString(), phase: 'agent_running', ...runningDetail },
  });
}

async function main() {
  // ---------------------------------------------------------------------------
  // 1. A real worker publishes its own identity, and a killed worker's job is
  //    resolved by the ordinary read path — not left `running`.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    let child = null;
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'liveness-1';
      store.createJob({
        jobId, repoKey: REPO_KEY, repoRoot: process.cwd(),
        backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
        mode: 'submit', access: 'read-only',
      });
      const jobDir = store.getJobDir(REPO_KEY, jobId);
      fs.writeFileSync(path.join(jobDir, 'prompt.txt'), 'hello', 'utf8');
      // A fake adapter that never emits process_exited: the worker stays in its
      // Observe loop until we kill it, which is the scenario under test.
      fs.writeFileSync(path.join(jobDir, 'params.json'), JSON.stringify({
        canonicalDir: process.cwd(), mode: 'run', access: 'read-only',
        _adapterScript: { facts: [{ type: 'started', delayMs: 60000 }] },
      }), 'utf8');
      fs.mkdirSync(path.join(jobDir, 'attempts', '1'), { recursive: true });

      child = spawn(process.execPath, [path.resolve(__dirname, '..', '..', 'core', 'commands', 'worker.js')], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
          ...process.env,
          DCLI_WORKER: '1',
          DCLI_STATE_ROOT: dir,
          DCLI_BACKEND: 'fake',
          DCLI_JOB_ID: jobId,
          DCLI_REPO_KEY: REPO_KEY,
          DCLI_REPO_ROOT: process.cwd(),
          DCLI_WORKER_HARD_TIMEOUT_MS: '60000',
        },
      });

      // Synchronize on observed state, never a fixed sleep.
      const deadline = Date.now() + 30000;
      let status = null;
      while (Date.now() < deadline) {
        try {
          status = store.readStatus({ repoKey: REPO_KEY, jobId });
          if (status.state === 'running' && status.worker_pid) break;
        } catch {}
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }

      assert.strictEqual(status && status.state, 'running', 'worker must reach running');
      assert.strictEqual(status.worker_pid, child.pid,
        'the running transition must persist the worker pid, or cancel and reconciliation have no identity to act on');
      assert.ok(status.worker_identity && status.worker_identity.startsWith(String(child.pid) + ';'),
        `worker_identity must name the worker: ${status.worker_identity}`);

      await killAndVerify(child);

      // The heartbeat has to age past the reducer's staleness threshold before a
      // dead worker is provable; rewrite it rather than waiting 15s of wall clock.
      const journalPath = path.join(jobDir, 'journal.jsonl');
      const stale = new Date(Date.now() - 60000).toISOString();
      fs.writeFileSync(journalPath, fs.readFileSync(journalPath, 'utf8')
        .split('\n')
        .map(l => (l.includes('"heartbeat"') ? l.replace(/"heartbeat_at":"[^"]+"/g, `"heartbeat_at":"${stale}"`) : l))
        .join('\n'), 'utf8');

      const { status: resolved } = loadJobOrThrow({ store, repoKey: REPO_KEY, jobId });
      assert.strictEqual(resolved.state, 'interrupted',
        `a killed worker must resolve on the read path, got "${resolved.state}" — a job nothing is executing must never stay running`);

      // Durable, not just in-memory: the next read agrees.
      assert.strictEqual(store.readStatus({ repoKey: REPO_KEY, jobId }).state, 'interrupted',
        'the reconciled state must be journaled, or the next journal replay resurrects `running`');
      console.log('PASS: liveness 1 — killed worker resolves to interrupted');
    } finally {
      await killAndVerify(child);
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. A live worker is left alone.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    try {
      const store = new JobStore({ stateRoot: dir });
      seedRunningJob(store, 'liveness-2', {
        worker_pid: process.pid,
        worker_identity: `${process.pid};${new Date().toISOString()}`,
      });
      store.writeHeartbeat({ repoKey: REPO_KEY, jobId: 'liveness-2' });

      const { status } = loadJobOrThrow({ store, repoKey: REPO_KEY, jobId: 'liveness-2' });
      assert.strictEqual(status.state, 'running',
        'a job whose worker is alive must not be reconciled to a terminal state');
      console.log('PASS: liveness 2 — live worker is not reconciled away');
    } finally {
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Cancelling a running job with no recorded identity must not claim success.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'liveness-3';
      seedRunningJob(store, jobId, {});

      const result = await cancelJob({
        store, adapter: new FakeAdapter({ declaredRungs: ['hard_kill'], facts: [] }),
        jobDir: store.getJobDir(REPO_KEY, jobId), repoKey: REPO_KEY, jobId,
        attempt: {}, attemptNum: 1,
        containment: null, executionToken: 'tok-test', pid: null,
        isProcessAliveFn: () => false,
        rungWaitMs: 10, hardKillWaitMs: 50,
      });

      assert.strictEqual(result.exitCode, 21,
        'cancelling a running job we cannot identify must report unconfirmed, not success');
      assert.strictEqual(result.warning, 'termination_unconfirmed');
    assert.notStrictEqual(result.cancelRungReached, 'hard_kill',
      'no rung may be credited when nothing observable happened');
      assert.notStrictEqual(store.readStatus({ repoKey: REPO_KEY, jobId }).state, 'cancelled',
        'never write `cancelled` for a process we did not touch');
      console.log('PASS: liveness 3 — cancel without identity is honest');
    } finally {
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. A live foreign process is not reported dead, so its admission slot and
  //    its locks survive. Comparing a Node-side timestamp against an OS start
  //    time always mismatched, which reclaimed live slots and quarantined live
  //    locks — silently removing the concurrency limit.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    let child = null;
    try {
      child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
      });

      assert.strictEqual(
        isSameProcessAlive({ pid: child.pid, startTime: new Date().toISOString(), startTimeSource: 'node' }),
        true,
        'a live foreign process recorded with a Node-side start time must not be judged dead');

      const admission = new AdmissionController({ stateRoot: dir, backendLimits: {} });
      const slotDir = path.join(dir, 'locks', 'admission');
      fs.mkdirSync(slotDir, { recursive: true });
      fs.writeFileSync(path.join(slotDir, 'foreign.json'), JSON.stringify({
        slotId: 'foreign', backend: 'fake', pid: child.pid,
        startTime: new Date().toISOString(), startTimeSource: 'node',
        imagePath: process.execPath, executionToken: 'other',
      }), 'utf8');

      assert.strictEqual(admission.reconcile(), 0,
        "reconcile must not reclaim another live process's slot");
      assert.strictEqual(admission.getUtilization().global.active, 1,
        'a live foreign slot must count against the concurrency limit');
      console.log('PASS: liveness 4 — foreign live process keeps its slot');
    } finally {
      await killAndVerify(child);
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 5. A classified provider failure (quota, auth) keeps its class even when the
  //    backend also exits non-zero — otherwise "out of credit" reads as a plain
  //    exit 1 and the caller cannot tell it apart from a retryable failure.
  // ---------------------------------------------------------------------------
  {
    const base = { state: 'running', job_id: 'x', failure_reason: null, backend_session_id: null };
    const reduced = reduce(base, [
      { type: 'backend_error', class_hint: 'quota_or_rate_limit' },
      { type: 'process_exited', code: 1 },
    ], {});

    assert.strictEqual(reduced.state, 'failed');
    assert.strictEqual(reduced.failure_reason, 'quota_or_rate_limit',
      'a non-zero exit must not swallow the reported failure class');
    assert.strictEqual(reduced.failure.class, 'quota_or_rate_limit');

    const { terminalExitCode } = require('../../core/failure-class');
    assert.strictEqual(terminalExitCode(reduced.state, reduced.failure, reduced.failure_reason), 14,
      'quota exhaustion must surface as exit 14, not 1');
    assert.notStrictEqual(terminalExitCode('failed', null, null), 0,
      'the worker writes this code into the completion sentinel, and a zero sentinel reads as `done` — a failed attempt must never produce one');
    assert.strictEqual(terminalExitCode('cancelled', null, null), 0,
      'a cancelled attempt must publish a successful cancellation exit code');
    console.log('PASS: liveness 5 — failure class survives a non-zero exit');
  }

  // ---------------------------------------------------------------------------
  // 6b. A torn final journal line (worker killed mid-append) must not make the
  //     whole job unreadable — that is precisely when the user needs to read it.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    try {
      const store = new JobStore({ stateRoot: dir });
      seedRunningJob(store, 'liveness-7', {});
      const journalPath = path.join(store.getJobDir(REPO_KEY, 'liveness-7'), 'journal.jsonl');
      fs.appendFileSync(journalPath, '{"seq":9,"kind":"heart', 'utf8');

      const status = store.regenerateStatus({ repoKey: REPO_KEY, jobId: 'liveness-7' });
      assert.strictEqual(status.state, 'running', 'a torn trailing line must be dropped, not fatal');

      // A newline-terminated final record that is corrupt is NOT a torn
      // append — it is corruption of a fully written transition, and hiding it
      // would let inferred state replace a real terminal result.
      fs.appendFileSync(journalPath, '{"seq":10,"kind":"broke\n', 'utf8');
      assert.throws(
        () => store.regenerateStatus({ repoKey: REPO_KEY, jobId: 'liveness-7' }),
        /JSON/,
        'a complete but corrupt final record must be reported, never silently skipped');

      fs.writeFileSync(journalPath, 'not json\n' + fs.readFileSync(journalPath, 'utf8'), 'utf8');
      // (the corrupt line above is no longer last, so it throws for that reason too)
      assert.throws(
        () => store.regenerateStatus({ repoKey: REPO_KEY, jobId: 'liveness-7' }),
        /JSON/,
        'corruption that is not a torn tail must still be reported, never silently skipped');
      console.log('PASS: liveness 6b — torn journal tail tolerated, real corruption is not');
    } finally {
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 6d. Tolerating a torn tail on READ is not enough: the next append lands
  //     against those bytes and produces one newline-terminated garbage line,
  //     which is permanent corruption. The write path must repair first.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'liveness-9';
      seedRunningJob(store, jobId, {});
      const journalPath = path.join(store.getJobDir(REPO_KEY, jobId), 'journal.jsonl');
      const goodLineCount = fs.readFileSync(journalPath, 'utf8').trim().split('\n').length;
      fs.appendFileSync(journalPath, '{"seq":9,"kind":"heart', 'utf8');

      store.writeHeartbeat({ repoKey: REPO_KEY, jobId });

      const entries = store.readJournal({ repoKey: REPO_KEY, jobId });
      assert.strictEqual(entries.length, goodLineCount + 1,
        'the torn record must be dropped and the new one appended cleanly');
      assert.strictEqual(store.regenerateStatus({ repoKey: REPO_KEY, jobId }).state, 'running',
        'the journal must remain replayable after a write that followed a torn tail');
      console.log('PASS: liveness 6d — a write after a torn tail repairs instead of corrupting');
    } finally {
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 6e. A recorded worker identity must be able to outlive PID reuse: it
  //     carries an OS-sourced creation time, so a different process holding
  //     the same pid is not mistaken for the worker.
  // ---------------------------------------------------------------------------
  {
    const { workerIdentityDetail, parseWorkerIdentity, isSameProcessAlive } = require('../../core/process-identity');
    const detail = workerIdentityDetail();
    const parsed = parseWorkerIdentity(detail.worker_identity);

    assert.strictEqual(parsed.pid, process.pid);
    assert.strictEqual(isSameProcessAlive(parsed), true, 'our own live process must verify');

    if (parsed.startTimeSource === 'os') {
      assert.strictEqual(
        isSameProcessAlive({ pid: process.pid, startTime: '1999-01-01T00:00:00.000Z', startTimeSource: 'os' }),
        false,
        'a pid whose OS creation time does not match is a different process, not the worker');
    } else {
      console.log('  (note) OS start time unavailable here; identity degraded to bare liveness');
    }

    // Backward compatibility: identities written before the tag still parse.
    const legacy = parseWorkerIdentity(`${process.pid};2020-01-01T00:00:00.000Z`);
    assert.strictEqual(legacy.startTimeSource, 'node');
    assert.strictEqual(legacy.startTime, '2020-01-01T00:00:00.000Z');
    console.log('PASS: liveness 6e — worker identity carries a comparable creation time');
  }

  // ---------------------------------------------------------------------------
  // 6f. `list` must report a record it could not read, not quietly shrink.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    try {
      const store = new JobStore({ stateRoot: dir });
      seedRunningJob(store, 'liveness-10', {});
      const journalPath = path.join(store.getJobDir(REPO_KEY, 'liveness-10'), 'journal.jsonl');
      fs.appendFileSync(journalPath, 'not json at all\n', 'utf8');

      const { executeList } = require('../../core/commands/list');
      const listed = await executeList({ store });
      assert.ok(listed.errors.length > 0,
        'an unreadable record must be reported, never presented as a healthy row');
      assert.ok(listed.errors.some(e => e.includes('liveness-10')));

      // `wait --all` is built on this listing. `every` over an empty or
      // partial set is vacuously true, so an unreadable record must block
      // completion rather than be counted as finished.
      const { executeWaitAll } = require('../../core/commands/wait');
      const waited = await executeWaitAll({ store, timeoutSec: 1, pollMs: 100 });
      // 17, not 0 and not 20: an unreadable record is corrupt state, not work
      // still in progress, and certainly not completion.
      assert.strictEqual(waited.exitCode, 17,
        'wait --all must not report success while a job record cannot be read');
      assert.strictEqual(listed.exitCode, 17, 'list reports corrupt state too');
      assert.ok((waited.errors || []).length > 0, 'and it must say which one');
      console.log('PASS: liveness 6f — list and wait --all report unreadable records');
    } finally {
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 6g. status.json is a projection, not the record. A job whose projection is
  //     missing must still be listed — it used to vanish from `list`, and from
  //     `wait --all`, which then reported the remaining set as complete.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    try {
      const store = new JobStore({ stateRoot: dir });
      seedRunningJob(store, 'liveness-11', {});
      fs.rmSync(path.join(store.getJobDir(REPO_KEY, 'liveness-11'), 'status.json'));

      const { executeList } = require('../../core/commands/list');
      const listed = await executeList({ store });
      assert.strictEqual(listed.jobs.length, 1,
        'a job with a journal but no projection is still a job');
      assert.strictEqual(listed.jobs[0].job_id, 'liveness-11');

      // A corrupt projection is the same situation: replayable from the journal.
      // The store only replays when the journal is at least as new as the
      // projection (mtime comparison), so writing the corrupt status.json
      // after the journal left the verdict to the wall clock's mtime tick.
      // Bump the journal's mtime to make the stale branch deterministic.
      seedRunningJob(store, 'liveness-12', {});
      const liveness12Dir = store.getJobDir(REPO_KEY, 'liveness-12');
      fs.writeFileSync(path.join(liveness12Dir, 'status.json'), '{ not json', 'utf8');
      const bump = new Date(Date.now() + 1000);
      fs.utimesSync(path.join(liveness12Dir, 'journal.jsonl'), bump, bump);
      const relisted = await executeList({ store });
      const row = relisted.jobs.find(j => j.job_id === 'liveness-12');
      assert.ok(row, 'a corrupt projection must be regenerated, not reported as an unreadable job');
      assert.strictEqual(row.state, 'running');
      console.log('PASS: liveness 6g — a missing or corrupt projection does not erase the job');
    } finally {
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 6h. Completion-sentinel evidence: the published state beats the exit code,
  //     and an unreadable sentinel is not evidence of anything.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    try {
      const store = new JobStore({ stateRoot: dir });
      const attemptDir = (jobId) => path.join(store.getJobDir(REPO_KEY, jobId), 'attempts', '1');
      const deadIdentity = { worker_pid: 999999, worker_identity: '999999;os:2020-01-01T00:00:00.0000000Z' };

      // An interrupted attempt exits 0. Without the recorded state that reads
      // as `done` — a job cut short reported as a clean success.
      seedRunningJob(store, 'liveness-13', deadIdentity);
      fs.writeFileSync(path.join(attemptDir('liveness-13'), 'worker-complete.json'),
        JSON.stringify({ exit_code: 0, state: 'interrupted' }), 'utf8');
      assert.strictEqual(store.reconcileStatus({ repoKey: REPO_KEY, jobId: 'liveness-13' }).state, 'interrupted',
        'the state the worker published wins over an inference from its exit code');

      // A half-written sentinel must not count as "the worker completed".
      seedRunningJob(store, 'liveness-14', deadIdentity);
      fs.writeFileSync(path.join(attemptDir('liveness-14'), 'worker-complete.json'), '{"exit_c', 'utf8');
      const reconciled = store.reconcileStatus({ repoKey: REPO_KEY, jobId: 'liveness-14' });
      assert.strictEqual(reconciled.state, 'interrupted',
        'an unparseable sentinel is absent evidence, not a confirmed failed completion');

      // A well-formed success sentinel still resolves to done.
      seedRunningJob(store, 'liveness-15', deadIdentity);
      fs.writeFileSync(path.join(attemptDir('liveness-15'), 'worker-complete.json'),
        JSON.stringify({ exit_code: 0, state: 'done' }), 'utf8');
      assert.strictEqual(store.reconcileStatus({ repoKey: REPO_KEY, jobId: 'liveness-15' }).state, 'done');
      console.log('PASS: liveness 6h — sentinel state is authoritative, damaged sentinels are not evidence');
    } finally {
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 6i. A passing read must never publish an outcome for a live worker.
  //     `cancel` annotates cancel_requested_at before its rungs run; a
  //     concurrent status/wait/list would otherwise journal `cancelled`, and
  //     terminal monotonicity then blocks the worker's real `done` forever.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'liveness-16';
      // Our own process stands in for the live worker.
      const { workerIdentityDetail } = require('../../core/process-identity');
      seedRunningJob(store, jobId, workerIdentityDetail());
      store.journalTransition(jobId, REPO_KEY, {
        kind: 'attempt_state_changed', attempt: 1, from: 'running', to: null,
        detail: { cancel_requested_at: new Date().toISOString() },
      });

      const { status: read } = loadJobOrThrow({ store, repoKey: REPO_KEY, jobId });
      assert.strictEqual(read.state, 'running',
        'a read must not journal cancelled while the worker that owns the job is alive');

      // The worker then publishes its real result, and it must win.
      store.journalTransition(jobId, REPO_KEY, {
        kind: 'attempt_state_changed', attempt: 1, from: 'running', to: 'done',
        detail: { finished_at: new Date().toISOString(), phase: 'terminal', result_bytes: 10 },
      });
      assert.strictEqual(store.readStatus({ repoKey: REPO_KEY, jobId }).state, 'done',
        "the worker's real outcome must not have been outranked by an inferred one");
      console.log('PASS: liveness 6i — reconciliation does not publish for a live worker');
    } finally {
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 6j. Reads stay zero-wait (tickets 04/05). Read-side reconciliation may
  //     publish, but must never block behind the writer lock to do it.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    const { LockManager, LOCK_SCOPES } = require('../../core/locking');
    let held = null;
    let holder = null;
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'liveness-17';
      seedRunningJob(store, jobId, { worker_pid: 999999, worker_identity: '999999;os:2020-01-01T00:00:00.0000000Z' });
      store.journalTransition(jobId, REPO_KEY, {
        kind: 'heartbeat', attempt: null, from: null, to: null,
        detail: { heartbeat_at: new Date(Date.now() - 60000).toISOString() },
      });

      holder = new LockManager({ lockDir: path.join(dir, 'locks') });
      held = holder.acquire(LOCK_SCOPES.PER_JOB, `${REPO_KEY}-${jobId}`, { operation: 'fake-writer' });

      const started = Date.now();
      const { status } = loadJobOrThrow({ store, repoKey: REPO_KEY, jobId });
      const elapsed = Date.now() - started;

      assert.ok(elapsed < 2000,
        `a read must not wait on the writer lock (waited ${elapsed}ms; the lock timeout is 10s)`);
      // And it reports the last durable state rather than a terminal it could
      // not journal: a terminal that is not in the journal is taken back by
      // the next replay, so `wait` would see completion, then not.
      assert.strictEqual(status.state, 'running',
        'under contention the read reports the journaled state and lets the next poll publish');
      assert.strictEqual(store.readStatus({ repoKey: REPO_KEY, jobId }).state, 'running');

      holder.release(held);
      held = null;
      assert.strictEqual(loadJobOrThrow({ store, repoKey: REPO_KEY, jobId }).status.state, 'interrupted',
        'once the lock is free the same read publishes the reconciled state');
      console.log(`PASS: liveness 6j — reads stay zero-wait under a held writer lock (${elapsed}ms)`);
    } finally {
      if (held && holder) holder.release(held);
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 6k. Cancelling a worker that already died must report what happened to it,
  //     never credit the cancellation with a death it had no part in.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'liveness-18';
      seedRunningJob(store, jobId, { worker_pid: 999999, worker_identity: '999999;os:2020-01-01T00:00:00.0000000Z' });
      store.journalTransition(jobId, REPO_KEY, {
        kind: 'heartbeat', attempt: null, from: null, to: null,
        detail: { heartbeat_at: new Date(Date.now() - 60000).toISOString() },
      });

      const result = await cancelJob({
        store, adapter: new FakeAdapter({ declaredRungs: ['hard_kill'], facts: [] }),
        jobDir: store.getJobDir(REPO_KEY, jobId), repoKey: REPO_KEY, jobId,
        attempt: {}, attemptNum: 1,
        containment: null, executionToken: 'tok-test', pid: 999999,
        isProcessAliveFn: () => false,
        rungWaitMs: 10, hardKillWaitMs: 50,
      });

      assert.strictEqual(result.cancelRungReached, 'already_exited');
      assert.strictEqual(result.state, 'interrupted',
        'a worker that crashed before publishing must read as interrupted, not as a clean cancellation');
      assert.notStrictEqual(store.readStatus({ repoKey: REPO_KEY, jobId }).state, 'cancelled');
      console.log('PASS: liveness 6k — an already-dead worker is not reported as cancelled');
    } finally {
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 6l. A lock must never be observable in a half-created state: an empty or
  //     unparseable lock file used to read as stale, so a contender could
  //     quarantine a lock that was being created and hold it at the same time.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    const { LockManager, LOCK_SCOPES } = require('../../core/locking');
    let held = null;
    let a = null;
    try {
      a = new LockManager({ lockDir: path.join(dir, 'locks'), timeoutMs: 200 });
      held = a.acquire(LOCK_SCOPES.PER_JOB, 'atomic-key', { operation: 'holder' });
      const content = fs.readFileSync(held.lockPath, 'utf8');
      assert.ok(JSON.parse(content).pid, 'a lock file is complete the moment it exists');

      // Simulate a contender meeting a zero-byte file: it must NOT be taken as
      // abandoned on sight.
      const b = new LockManager({ lockDir: path.join(dir, 'locks'), timeoutMs: 200 });
      fs.writeFileSync(held.lockPath, '', 'utf8');
      assert.strictEqual(b.tryAcquire(LOCK_SCOPES.PER_JOB, 'atomic-key', { operation: 'contender' }), null,
        'an unparseable lock file must not be quarantined on sight — that is how two holders happen');

      // No temp files left behind.
      const strays = fs.readdirSync(path.join(dir, 'locks')).filter(f => f.endsWith('.tmp'));
      assert.deepStrictEqual(strays, [], 'lock creation must not leak temp files');
      console.log('PASS: liveness 6l — lock files are created atomically');
    } finally {
      if (held && a) a.release(held);
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 6m. A legacy job with no recorded worker identity is resolved only after
  //     its own hard-timeout deadline. Before the deadline, it remains active.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'liveness-19';
      seedRunningJob(store, jobId, {
        started_at: new Date(Date.now() - 60000).toISOString(),
      }, { hardTimeoutSec: 1 });   // no worker_pid, no worker_identity
      store.journalTransition(jobId, REPO_KEY, {
        kind: 'heartbeat', attempt: null, from: null, to: null,
        detail: { heartbeat_at: new Date(Date.now() - 600000).toISOString() },
      });

      const { status } = loadJobOrThrow({ store, repoKey: REPO_KEY, jobId });
      assert.strictEqual(status.state, 'interrupted',
        'an identityless job past its own deadline must resolve to interrupted');
      assert.strictEqual(status.failure_reason, 'worker_identity_missing',
        'the terminal reason must name the missing launch identity');
      assert.notStrictEqual(status.state, 'cancelled',
        'identityless reconciliation must never claim cancellation');
      assert.strictEqual(store.readStatus({ repoKey: REPO_KEY, jobId }).state, 'interrupted',
        'the reconciled state must be durable');
      console.log('PASS: liveness 6m — expired identityless job resolves to interrupted');
    } finally {
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 6n. The identityless recovery rule is bounded by the recorded deadline,
  //     and does not replace the identity-backed liveness proof.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'liveness-20';
      seedRunningJob(store, jobId, {
        started_at: new Date(Date.now() - 1000).toISOString(),
      }, { hardTimeoutSec: 60 });
      store.journalTransition(jobId, REPO_KEY, {
        kind: 'heartbeat', attempt: null, from: null, to: null,
        detail: { heartbeat_at: new Date(Date.now() - 600000).toISOString() },
      });

      assert.strictEqual(loadJobOrThrow({ store, repoKey: REPO_KEY, jobId }).status.state, 'running',
        'an identityless job inside its deadline must remain running');

      const identityJobId = 'liveness-21';
      seedRunningJob(store, identityJobId, {
        started_at: new Date(Date.now() - 60000).toISOString(),
        worker_pid: 999999,
        worker_identity: '999999;os:2020-01-01T00:00:00.0000000Z',
      }, { hardTimeoutSec: 1 });
      store.journalTransition(identityJobId, REPO_KEY, {
        kind: 'heartbeat', attempt: null, from: null, to: null,
        detail: { heartbeat_at: new Date(Date.now() - 600000).toISOString() },
      });

      const identityStatus = loadJobOrThrow({ store, repoKey: REPO_KEY, jobId: identityJobId }).status;
      assert.strictEqual(identityStatus.state, 'timed_out',
        'a record with identity must use the identity-backed timeout path');
      assert.notStrictEqual(identityStatus.failure_reason, 'worker_identity_missing',
        'the identityless reason must not be used for identity-backed records');
      console.log('PASS: liveness 6n — deadline and identity boundaries hold');
    } finally {
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 6o. Reconciliation preserves prior failure metadata while assigning the
  //     missing-identity reason when no prior reason exists.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'liveness-22';
      seedRunningJob(store, jobId, {
        started_at: new Date(Date.now() - 60000).toISOString(),
      }, { hardTimeoutSec: 1 });
      store.journalTransition(jobId, REPO_KEY, {
        kind: 'attempt_state_changed', attempt: 1, from: 'running', to: null,
        detail: { failure_reason: 'previous_failure', backend_session_id: 'ses_keep' },
      });
      store.journalTransition(jobId, REPO_KEY, {
        kind: 'heartbeat', attempt: null, from: null, to: null,
        detail: { heartbeat_at: new Date(Date.now() - 600000).toISOString() },
      });

      const { status } = loadJobOrThrow({ store, repoKey: REPO_KEY, jobId });
      assert.strictEqual(status.state, 'interrupted');
      assert.strictEqual(status.failure_reason, 'previous_failure',
        'reconciliation must preserve an existing failure reason');
      assert.strictEqual(status.backend_session_id, 'ses_keep',
        'reconciliation must preserve backend_session_id');
      console.log('PASS: liveness 6o — reconciliation preserves failure metadata');
    } finally {
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 6p. The post-deadline final read honours the same corruption contract as
  //     the polling loop (ticket 111): an unreadable record in the FINAL
  //     listing is exit 17 with timedOut: false, never a caller timeout.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    try {
      const store = new JobStore({ stateRoot: dir });

      // Zero wait budget: the polling loop never runs, so the corrupt record
      // is only ever seen by the deadline fall-through read.
      seedRunningJob(store, 'liveness-23', {});
      const journalPath = path.join(store.getJobDir(REPO_KEY, 'liveness-23'), 'journal.jsonl');
      fs.appendFileSync(journalPath, 'not json at all\n', 'utf8');

      const { executeWaitAll } = require('../../core/commands/wait');
      const waited = await executeWaitAll({ store, timeoutSec: 0, pollMs: 100 });
      assert.strictEqual(waited.exitCode, 17,
        'a corrupt record in the final listing is corrupt state, not a budget expiry');
      assert.strictEqual(waited.timedOut, false,
        'corruption must not be reported as a caller timeout');
      assert.ok((waited.errors || []).length > 0, 'and it must say which record');
      console.log('PASS: liveness 6p — final-read corruption returns exit 17');

      // And the timeout branch survives: readable but still-active jobs after
      // the deadline still exit 20 with timedOut: true. Fresh dir — the
      // corrupt record above must not leak into this listing.
      const dir2 = tmpDir();
      try {
        const store2 = new JobStore({ stateRoot: dir2 });
        seedRunningJob(store2, 'liveness-24', {});
        const active = await executeWaitAll({ store: store2, timeoutSec: 0, pollMs: 100 });
        assert.strictEqual(active.exitCode, 20,
          'still-active jobs after the deadline must keep exiting 20');
        assert.strictEqual(active.timedOut, true);
        console.log('PASS: liveness 6p — deadline fall-through still exits 20');
      } finally {
        clean(dir2);
      }
    } finally {
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 6c. A losing terminal claim must not stamp its metadata onto the winner.
  //     Reconciliation and a worker publishing at the same moment is a real
  //     race: replay keeps `done`, but the loser's finished_at/failure_reason
  //     used to be applied anyway, producing a job that was done AND failed.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'liveness-8';
      seedRunningJob(store, jobId, {});
      store.journalTransition(jobId, REPO_KEY, {
        kind: 'attempt_state_changed', attempt: 1, from: 'running', to: 'done',
        detail: { finished_at: '2020-01-01T00:00:00.000Z', phase: 'terminal', result_bytes: 42 },
      });
      store.journalTransition(jobId, REPO_KEY, {
        kind: 'attempt_state_changed', attempt: 1, from: 'running', to: 'interrupted',
        detail: {
          finished_at: '2030-01-01T00:00:00.000Z', phase: 'terminal',
          failure_reason: 'worker_lost', failure: { reason: 'worker_lost' }, reconciled: true,
        },
      });

      const status = store.readStatus({ repoKey: REPO_KEY, jobId });
      assert.strictEqual(status.state, 'done', 'the published terminal state wins');
      assert.strictEqual(status.failure_reason, null,
        'the losing claim must not attach a failure reason to a completed job');
      assert.strictEqual(status.failure, null, 'nor a failure object');
      assert.strictEqual(status.finished_at, '2020-01-01T00:00:00.000Z',
        'nor rewrite when the job actually finished');
      console.log('PASS: liveness 6c — a preserved terminal state ignores the loser\'s detail');
    } finally {
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 6. The adapters deliver process_exited last, so a classification appended
  //    after it is still read by the engine.
  // ---------------------------------------------------------------------------
  {
    const { applyProcessLifecycle } = require('../../adapters/shared/process-lifecycle');
    class Probe {}
    applyProcessLifecycle(Probe);
    const probe = new Probe();
    probe._facts = [
      { type: 'started' },
      { type: 'process_exited', code: 1 },
      { type: 'backend_error', class_hint: 'authentication' },
    ];
    const order = [...probe._orderedTerminalFacts()].map(f => f.type);
    assert.strictEqual(order[order.length - 1], 'process_exited',
      'process_exited ends the attempt, so anything after it in the array is never delivered');
    assert.ok(order.indexOf('backend_error') < order.indexOf('process_exited'));
    console.log('PASS: liveness 6 — process_exited is yielded last');
  }

  console.log('\nAll worker liveness tests passed.');

}

main().catch(err => { console.error(err); process.exit(1); });
