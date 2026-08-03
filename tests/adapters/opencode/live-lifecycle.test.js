// @suite full
// @serial  live backend; external rate limits; process trees
// @timeout-ms 600000
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { computeRepoKeyWithPath } = require('../../../core/repo-key');
const { JobStore } = require('../../../core/job-store');
const { parseWorkerIdentity, isSameProcessAlive } = require('../../../core/process-identity');

const OPENCODE_LIVE_SMOKE = process.env.DCLI_OPENCODE_LIVE_SMOKE;
const TERMINAL = ['done', 'failed', 'timed_out', 'cancelled', 'interrupted'];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-ll-'));
  return d;
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function initGitRepo(dir) {
  const r = cp.spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.strictEqual(r.status, 0, `git init must succeed in ${dir}: ${r.stderr}`);
  cp.spawnSync('git', ['config', 'user.email', 'test@dcli.local'], { cwd: dir, encoding: 'utf8', timeout: 5000, windowsHide: true });
  cp.spawnSync('git', ['config', 'user.name', 'dcli test'], { cwd: dir, encoding: 'utf8', timeout: 5000, windowsHide: true });
}

function assertIsDead(pid, message) {
  try {
    process.kill(pid, 0);
    assert.fail(`${message}: expected process ${pid} to be gone, but kill(0) succeeded`);
  } catch (err) {
    // assert.fail throws an AssertionError which must propagate.
    if (err && err.constructor && err.constructor.name === 'AssertionError') throw err;
    if (err.code === 'ESRCH') return;
    if (err.message && err.message.includes('not found')) return;
    if (err.message && err.message.includes('No such process')) return;
    if (err.message && err.message.includes('no process')) return;
    if (err.message && err.message.includes('failed')) return;
    if (err.code === 'EPERM') {
      assert.fail(`${message}: process ${pid} still exists (kill(0) returned EPERM)`);
    }
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true;
    if (err.code === 'ESRCH') return false;
    if (err.message && /not found|no such process|no process/i.test(err.message)) return false;
    throw err;
  }
}

function forceKillIfAlive(pid, label) {
  if (!isAlive(pid)) return false;
  const result = cp.spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], {
    windowsHide: true,
    timeout: 10000,
  });
  // The process may race with taskkill and exit after the liveness check. In
  // that case the observable postcondition is still satisfied; report a real
  // failure only when the process remains alive.
  if (result.status !== 0) {
    if (isAlive(pid)) {
      assert.fail(`${label} taskkill failed: ${result.stderr || result.error || result.status}`);
    }
    return false;
  }
  return true;
}

async function waitForDeath(pid, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assertIsDead(pid, message);
}

function dcli(args, opts = {}) {
  return cp.spawnSync(process.execPath, [
    path.resolve(__dirname, '..', '..', '..', 'cli', 'dcli-opencode.js'),
    ...args,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeout || 120000,
    env: opts.env ? { ...process.env, ...opts.env } : { ...process.env },
  });
}

function dcliAsync(args, opts = {}) {
  return cp.spawn(process.execPath, [
    path.resolve(__dirname, '..', '..', '..', 'cli', 'dcli-opencode.js'),
    ...args,
  ], {
    windowsHide: true,
    env: opts.env ? { ...process.env, ...opts.env } : { ...process.env },
  });
}

let testLogs = [];

async function main() {
  if (!OPENCODE_LIVE_SMOKE || OPENCODE_LIVE_SMOKE === '0') {
    console.log('SKIP: DCLI_OPENCODE_LIVE_SMOKE not set — live lifecycle tests skipped');
    return;
  }

  // Verify opencode is available
  const hasOc = (() => {
    if (process.env.OPENCODE_PATH) return true;
    try {
      return cp.spawnSync('where', ['opencode'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).status === 0;
    } catch { return false; }
  })();
  if (!hasOc) {
    console.log('SKIP: opencode not found — live lifecycle tests skipped');
    return;
  }

  // ==========================================================================
  // P1.2 — Cancel a running job
  // ==========================================================================
  {
    const stateRoot = tmpDir();
    const repoDir = tmpDir();
    const env = { DCLI_STATE_ROOT: stateRoot };
    initGitRepo(repoDir);

    try {
      const submit = dcli([
        'submit',
        '--hard-timeout-sec', '120',
        '--model', 'opencode-go/deepseek-v4-flash',
        '--repo', repoDir,
        'Write a 3-page detailed technical essay on the history of functional programming paradigms from lambda calculus to modern Haskell. Each page must be at least 500 words.',
      ], { env, timeout: 30000 });

      assert.strictEqual(submit.status, 0, `submit exited ${submit.status}: ${submit.stderr}`);
      const jobId = (submit.stdout || '').trim();
      assert.ok(jobId.length >= 16, `Expected jobId, got: "${jobId}"`);

      testLogs.push(`P1.2 submit: job ${jobId}`);

      const cancel = dcli([
        'cancel', jobId,
        '--repo', repoDir,
      ], { env, timeout: 30000 });

      testLogs.push(`P1.2 cancel exited ${cancel.status}: ${cancel.stderr}`);

      const waitResult = dcli([
        'wait', jobId,
        '--repo', repoDir,
        '--timeout-sec', '60',
      ], { env, timeout: 70000 });

      const { repoKey } = computeRepoKeyWithPath(repoDir);
      const store = new JobStore({ stateRoot });
      let finalState = null;
      try {
        finalState = store.readStatus({ repoKey, jobId });
      } catch {}

      if (cancel.status === 0) {
        assert.ok(
          finalState && finalState.state === 'cancelled',
          `Expected cancelled state after successful cancel, got ${JSON.stringify(finalState ? finalState.state : 'no status')}. cancel exit ${cancel.status}, stderr: ${cancel.stderr}`
        );
        console.log(`PASS: P1.2 — Cancel: job ${jobId} cancelled successfully (state=${finalState.state})`);
      } else if (cancel.status === 21) {
        testLogs.push('P1.2 cancel returned 21 (unconfirmed) — job may have completed before cancel');
        console.log(`NOTE: P1.2 — cancel returned 21; job already in terminal state: ${finalState ? finalState.state : 'unknown'}`);
        assert.ok(finalState && TERMINAL.includes(finalState.state),
          `When cancel returns 21, job must be terminal. Got: ${JSON.stringify(finalState)}`);
        console.log(`PASS: P1.2 — Cancel unconfirmed (exit 21): job already terminal (${finalState.state})`);
      } else {
        assert.fail(`cancel exited ${cancel.status} with no classified outcome: ${cancel.stderr}`);
      }
    } catch (err) {
      console.error(`P1.2 FAIL: ${err.message}`);
      throw err;
    } finally {
      clean(stateRoot);
      clean(repoDir);
    }
  }

  // ==========================================================================
  // P1.3 — Detached worker and startup sentinel
  // ==========================================================================
  {
    const stateRoot = tmpDir();
    const repoDir = tmpDir();
    const env = { DCLI_STATE_ROOT: stateRoot };
    initGitRepo(repoDir);

    try {
      const { repoKey } = computeRepoKeyWithPath(repoDir);

      const submit = dcli([
        'submit',
        '--hard-timeout-sec', '120',
        '--model', 'opencode-go/deepseek-v4-flash',
        '--repo', repoDir,
        'Reply with exactly: WORKER_STARTUP_OK',
      ], { env, timeout: 30000 });

      assert.strictEqual(submit.status, 0, `submit exited ${submit.status}: ${submit.stderr}`);
      const jobId = (submit.stdout || '').trim();
      assert.ok(jobId.length >= 16, `Expected jobId, got: "${jobId}"`);

      testLogs.push(`P1.3 submit: job ${jobId}`);

      // Wait for terminal
      const waitResult = dcli([
        'wait', jobId,
        '--repo', repoDir,
        '--timeout-sec', '120',
      ], { env, timeout: 130000 });

      assert.strictEqual(waitResult.status, 0,
        `worker wait must exit 0: ${waitResult.stderr}`);

      const store = new JobStore({ stateRoot });
      const status = store.readStatus({ repoKey, jobId });

      testLogs.push(`P1.3 wait exited ${waitResult.status}, state=${status.state}`);

      // Verify worker-started.json sentinel exists in the attempt directory
      const attemptDir = path.join(store.getJobDir(repoKey, jobId), 'attempts', '1');
      const sentinelPath = path.join(attemptDir, 'worker-started.json');
      const sentinelExists = fs.existsSync(sentinelPath);

      // worker.log exists
      const workerLogPath = path.join(attemptDir, 'worker.log');
      const workerLogExists = fs.existsSync(workerLogPath);

      // backend-events.jsonl exists and has content
      const eventsPath = path.join(attemptDir, 'backend-events.jsonl');
      const eventsExists = fs.existsSync(eventsPath);

      // result.md is the usable result artifact, not just a terminal status.
      const resultPath = path.join(attemptDir, 'result.md');
      const resultExists = fs.existsSync(resultPath);
      const resultBytes = resultExists ? fs.statSync(resultPath).size : 0;

      // worker-complete.json sentinel
      const completeSentinel = path.join(attemptDir, 'worker-complete.json');
      const completeExists = fs.existsSync(completeSentinel);

      // Assert: at minimum, backend events must be persisted
      assert.ok(eventsExists, 'backend-events.jsonl must exist after a completed worker run');
      assert.ok(resultExists, 'result.md must exist after a completed worker run');
      assert.ok(resultBytes > 0, 'result.md must be non-empty after a completed worker run');
      assert.strictEqual(
        status.state, 'done',
        `Worker job must complete as done, got ${status.state}. failure_reason: ${status.failure_reason || 'none'}`
      );

      // Verify worker process is gone
      if (status.worker_pid) {
        assertIsDead(status.worker_pid, 'Worker process must be dead after completion');
      }

      console.log(`PASS: P1.3 — Worker lifecycle: state=${status.state}, worker-started.json=${sentinelExists}, worker.log=${workerLogExists}, events=${eventsExists}, stdout bytes=${(waitResult.stdout || '').length}`);
    } catch (err) {
      console.error(`P1.3 FAIL: ${err.message}`);
      throw err;
    } finally {
      clean(stateRoot);
      clean(repoDir);
    }
  }

  // ==========================================================================
  // P1.4 — Backend failure classification
  // ==========================================================================
  {
    const stateRoot = tmpDir();
    const repoDir = tmpDir();
    const env = { DCLI_STATE_ROOT: stateRoot };
    initGitRepo(repoDir);

    try {
      // Use a deliberately invalid provider/model that opencode accepts at
      // session creation but cannot actually invoke. Zero tokens + no
      // assistant response is detected and classified as provider_error.
      const result = dcli([
        'run',
        '--hard-timeout-sec', '60',
        '--model', 'garbage/no-such-model',
        '--repo', repoDir,
        'Reply with PONG',
        '--json',
      ], { env, timeout: 70000 });

      testLogs.push(`P1.4 exit ${result.status}`);

      assert.notStrictEqual(result.status, 0,
        `invalid model must not exit 0 (status=${result.status}, signal=${result.signal || 'none'}, error=${result.error ? result.error.message : 'none'})`);

      let parsed = null;
      try {
        parsed = JSON.parse((result.stdout || '').trim());
      } catch {}

      assert.ok(parsed,
        `P1.4 --json output must be valid JSON (status=${result.status}, signal=${result.signal || 'none'}, error=${result.error ? result.error.message : 'none'}). ` +
        `stdout: ${(result.stdout || '').slice(0, 200)} stderr: ${(result.stderr || '').slice(0, 500)}`);

      testLogs.push(`P1.4 state: ${parsed.state}, failure_reason: ${parsed.failure_reason}, failure.class: ${parsed.failure ? parsed.failure.class : 'none'}`);

      // The job must be in failed state (not done) with a failure classification
      assert.strictEqual(
        parsed.state, 'failed',
        `Invalid model must produce failed state, got ${parsed.state}`
      );
      assert.ok(
        parsed.failure_reason,
        'failure_reason must be set when model is invalid'
      );

      console.log(`PASS: P1.4 — Backend failure classified: state=${parsed.state}, failure_reason=${parsed.failure_reason}, failure.class=${parsed.failure ? parsed.failure.class : 'none'}`);
    } catch (err) {
      console.error(`P1.4 FAIL: ${err.message}`);
      throw err;
    } finally {
      clean(stateRoot);
      clean(repoDir);
    }
  }

  // ==========================================================================
  // P1.5 — Controller crash / reconciliation
  //
  // Strategy: submit a long prompt, wait briefly for the worker to start,
  // then kill the wrapper process. Reconciliation should mark the job as
  // interrupted or recover it to terminal.
  // ==========================================================================
  {
    const stateRoot = tmpDir();
    const repoDir = tmpDir();
    const env = { DCLI_STATE_ROOT: stateRoot };
    initGitRepo(repoDir);

    // Hoisted so the finally block below can read the durable identities even
    // when a mid-scenario assertion failed before they were (re)assigned.
    const { repoKey } = computeRepoKeyWithPath(repoDir);
    let jobId = null;

    try {
      // Submit a background job with a longer prompt so there's time to observe
      const submit = dcli([
        'submit',
        '--hard-timeout-sec', '300',
        '--model', 'opencode-go/deepseek-v4-flash',
        '--repo', repoDir,
        'Write a comprehensive 2000-word analysis of WebSocket protocol evolution and its impact on real-time web applications. Include historical context, protocol details, and modern alternatives.',
      ], { env, timeout: 30000 });

      assert.strictEqual(submit.status, 0, `submit exited ${submit.status}: ${submit.stderr}`);
      jobId = (submit.stdout || '').trim();
      assert.ok(jobId.length >= 16, `Expected jobId, got: "${jobId}"`);

      testLogs.push(`P1.5 submit: job ${jobId}`);

      // Poll until worker PID is known (worker registers itself)
      const store = new JobStore({ stateRoot });
      let workerPid = null;
      let backendPid = null;
      const pollDeadline = Date.now() + 30000;
      while (Date.now() < pollDeadline && workerPid === null) {
        try {
          const s = store.readStatus({ repoKey, jobId });
          if (s.worker_pid) workerPid = s.worker_pid;
          if (s.backend_pid) backendPid = s.backend_pid;
        } catch {}
        await new Promise(r => setTimeout(r, 500));
      }

      testLogs.push(`P1.5 worker_pid: ${workerPid}, backend_pid: ${backendPid}`);

      // The crash scenario under test is only exercised if the worker actually
      // started and was killed mid-run. Without these guards a job that never
      // spawned a worker (or already finished) would sail through the kill and
      // still hit a terminal reconcile state below — a false green. Fail loudly
      // instead.
      assert.ok(workerPid, `P1.5 must observe a worker pid before killing it (worker_pid=${workerPid})`);
      const preKillStatus = store.readStatus({ repoKey, jobId });
      assert.strictEqual(preKillStatus.state, 'running',
        `P1.5 worker kill requires a running job, got ${preKillStatus.state}`);
      assert.ok(preKillStatus.worker_identity, 'worker_identity must be set before kill');
      assert.ok(isAlive(workerPid), `P1.5 worker ${workerPid} must still be alive before killing it`);
      testLogs.push(`P1.5 worker_identity: ${preKillStatus.worker_identity}`);

      const workerIdentity = parseWorkerIdentity(preKillStatus.worker_identity);
      assert.ok(workerIdentity, 'worker_identity must be parseable before kill');
      assert.strictEqual(workerIdentity.pid, workerPid, 'worker_identity pid must match worker_pid');
      assert.ok(isSameProcessAlive(workerIdentity), 'worker_identity must identify the live worker before kill');
      const preKillSessionId = preKillStatus.backend_session_id;

      // Kill the innermost backend first, then the controller. The worker's
      // /T kill may already take the backend with it, so a second kill is
      // best-effort and checks the postcondition rather than its exit code.
      if (backendPid) {
        const beforeKill = store.readStatus({ repoKey, jobId });
        assert.ok(beforeKill.backend_pid, 'backend_pid must be set before kill');
        forceKillIfAlive(backendPid, `Backend ${backendPid}`);
        await waitForDeath(backendPid, 'Backend process must die after taskkill');
        testLogs.push('P1.5 backend server killed via taskkill /F /T');
      }

      // The worker is spawned windowsHide:true, so taskkill without /F cannot
      // terminate it ("can only be terminated forcefully"). Require taskkill
      // to observe the live worker; otherwise this test did not exercise a
      // controller crash.
      assert.strictEqual(forceKillIfAlive(workerPid, `Worker ${workerPid}`), true,
        'worker taskkill must hit the live worker');
      await waitForDeath(workerPid, 'Worker process must die after taskkill');
      testLogs.push('P1.5 worker killed via taskkill /F /T');

      // Now reconcile: worker-liveness-aware reconciliation detects the dead
      // worker and transitions to interrupted (not running). It is deliberately
      // conservative — a fresh heartbeat (<12s grace) proves liveness without a
      // process probe, so a killed worker is only provable once its last
      // heartbeat ages past the reducer's 15s staleness threshold. Poll on a
      // bounded interval rather than asserting after one immediate call.
      let reconciled = null;
      const reconcileDeadline = Date.now() + 30000;
      while (Date.now() < reconcileDeadline) {
        reconciled = store.reconcileStatus({ repoKey, jobId });
        if (TERMINAL.includes(reconciled.state)) break;
        await new Promise(r => setTimeout(r, 500));
      }
      testLogs.push(`P1.5 reconciled state: ${reconciled.state}, failure_reason: ${reconciled.failure_reason}`);

      // A worker killed mid-run with no completion sentinel must resolve to
      // `interrupted` — the crash-specific outcome. Accepting any terminal
      // state would let a worker that raced to `done` before dying read as a
      // clean crash recovery, which is not the scenario under test.
      assert.strictEqual(
        reconciled.state, 'interrupted',
        `A killed worker must reconcile to interrupted, got "${reconciled.state}"`
      );

      // Verify backend_session_id is preserved during reconciliation
      assert.strictEqual(reconciled.backend_session_id, preKillSessionId,
        `backend_session_id must survive reconciliation (before=${preKillSessionId || 'null'}, after=${reconciled.backend_session_id || 'null'})`);
      testLogs.push(`P1.5 backend_session_id preserved: ${reconciled.backend_session_id || 'N/A'}`);

      // Verify no surviving servers
      const serversDir = path.join(stateRoot, 'servers');
      if (fs.existsSync(serversDir)) {
        const remaining = fs.readdirSync(serversDir).filter(f => f.endsWith('.json'));
        testLogs.push(`P1.5 surviving server metadata files: ${remaining.length}`);
      }

      console.log(`PASS: P1.5 — Controller crash/reconciliation: state=${reconciled.state}, failure_reason=${reconciled.failure_reason || 'none'}`);
    } catch (err) {
      console.error(`P1.5 FAIL: ${err.message}`);
      throw err;
    } finally {
      // Never leave a hang-shaped fixture alive. If any assertion above failed
      // before the kill completed, the worker/backend may still be running and
      // would poison every later test on the machine. Re-read the job's durable
      // identity and force-kill anything still alive, boundedly.
      //
      // A leaked fixture must NOT be silently swallowed: if a process survives
      // teardown, delete nothing and report it, so the leak is visible and the
      // state root keeps its identity evidence for diagnosis.
      let teardownFailed = null;
      try {
        const store = new JobStore({ stateRoot });
        // Re-snapshot between innermost and controller kills; the controller's
        // process tree may remove the backend while the status still names it.
        for (const field of ['backend_pid', 'worker_pid']) {
          const s = store.readStatus({ repoKey, jobId });
          const pid = s[field];
          if (typeof pid !== 'number' || pid <= 0) continue;
          forceKillIfAlive(pid, `Fixture process ${pid}`);
          await waitForDeath(pid, `Fixture process ${pid} must die in teardown`);
        }
      } catch (err) {
        teardownFailed = err.message;
      }
      if (teardownFailed) {
        console.error(`P1.5 TEARDOWN LEAK: ${teardownFailed}. State root kept for diagnosis: ${stateRoot}`);
        throw new Error(teardownFailed);
      }
      clean(stateRoot);
      clean(repoDir);
    }
  }

  console.log('\n=== P1 Live Lifecycle Results ===');
  for (const log of testLogs) {
    console.log(`  ${log}`);
  }
  console.log('All P1 lifecycle tests passed.');
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
