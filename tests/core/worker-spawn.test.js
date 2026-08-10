// @suite full
// @serial  spawns detached worker children
//
// Ticket 97: the initial submit and the queued relaunch used to carry two
// copies of the worker spawn body that differed in stdio/error handling and
// in DCLI_QUEUE_CLAIM_PATH. One module — core/worker-spawn.js — now owns the
// spawn; the queue claim is a parameter. These tests assert the module's
// contract directly (environment diff, identity ordering) and one real
// end-to-end pass of the queued relaunch.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { JobStore } = require('../../core/job-store');
const { AdmissionController } = require('../../core/admission');
const { spawnWorker } = require('../../core/worker-spawn');
const { isProcessAlive } = require('../../core/process-identity');

const REPO_KEY = 'test';

function tmpDir() {
  const fixtureRoot = path.resolve(__dirname, '../../.tmp-test');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  return fs.mkdtempSync(path.join(fixtureRoot, 'dcli-worker-spawn-'));
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function waitForDeath(pid) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      if (!isProcessAlive(pid)) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`fixture pid ${pid} survived teardown`));
      setTimeout(poll, 50);
    };
    poll();
  });
}

function killAndVerify(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
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

function withNodeOptions(preload) {
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previous ? previous + ' ' : ''}--require=${preload}`;
  return () => {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A job record the worker can run without an adapter round trip: the fake
// emits `started` then exits cleanly.
function seedJob(store, jobId) {
  store.createJob({
    jobId, repoKey: REPO_KEY, repoRoot: process.cwd(),
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'submit', access: 'read-only',
  });
  const jobDir = store.getJobDir(REPO_KEY, jobId);
  fs.writeFileSync(path.join(jobDir, 'prompt.txt'), 'hello', 'utf8');
  fs.mkdirSync(path.join(jobDir, 'attempts', '1'), { recursive: true });
  fs.writeFileSync(path.join(jobDir, 'params.json'), JSON.stringify({
    canonicalDir: process.cwd(), mode: 'run', access: 'read-only',
    _adapterScript: { facts: [{ type: 'started', delayMs: 50 }, { type: 'process_exited', code: 0 }] },
  }), 'utf8');
}

function readCapture(capturePath) {
  try {
    return fs.readFileSync(capturePath, 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

// The preload body: hold the child alive briefly (so the launching side's OS
// identity query sees a live pid), write every DCLI_* env key the child sees,
// then stop. The `exitAfter` variant is for env capture only; the plain
// variant lets the child continue into worker.js.
function capturePreloadBody(exitAfter) {
  return "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);\n" +
    "require('fs').appendFileSync(process.env.WSPAWN_CAPTURE, " +
    "JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('DCLI_')))) + '\\n');\n" +
    (exitAfter ? 'process.exit(0);\n' : '');
}

async function main() {
  // ---------------------------------------------------------------------------
  // 1. The environment handed to the child is identical between the two call
  //    sites except for DCLI_QUEUE_CLAIM_PATH (criterion C), and the shared key
  //    set is exactly the expected one.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    const capture = path.join(dir, 'capture.jsonl');
    const preload = path.join(dir, 'capture-env-exit.js');
    fs.writeFileSync(preload, capturePreloadBody(true), 'utf8');
    const restore = withNodeOptions(preload);
    const previousCaptureEnv = process.env.WSPAWN_CAPTURE;
    process.env.WSPAWN_CAPTURE = capture;
    const children = [];
    try {
      const store = new JobStore({ stateRoot: dir });
      seedJob(store, 'j-submit');
      seedJob(store, 'j-queued');
      const claimPath = path.join(dir, 'queue', 'j-queued.launching-test.json');

      const submitSpawn = spawnWorker({
        store, stateRoot: dir, backend: 'fake', jobId: 'j-submit',
        repoKey: REPO_KEY, repoRoot: process.cwd(), hardTimeoutSec: 60,
        executionToken: 'tok-submit', queueClaimPath: null,
      });
      children.push(submitSpawn.child);
      await submitSpawn.launched;

      const queuedSpawn = spawnWorker({
        store, stateRoot: dir, backend: 'fake', jobId: 'j-queued',
        repoKey: REPO_KEY, repoRoot: process.cwd(), hardTimeoutSec: 60,
        executionToken: 'tok-queued', queueClaimPath: claimPath,
      });
      children.push(queuedSpawn.child);
      await queuedSpawn.launched;

      const deadline = Date.now() + 5000;
      let submitEnv = null;
      let queuedEnv = null;
      while (Date.now() < deadline) {
        const lines = readCapture(capture);
        submitEnv = lines.find(l => l.DCLI_JOB_ID === 'j-submit');
        queuedEnv = lines.find(l => l.DCLI_JOB_ID === 'j-queued');
        if (submitEnv && queuedEnv) break;
        sleep(50);
      }

      const queuedKeyed = { ...queuedEnv };
      const claimValue = queuedKeyed.DCLI_QUEUE_CLAIM_PATH;
      delete queuedKeyed.DCLI_QUEUE_CLAIM_PATH;
      // DCLI_JOB_ID is a per-job key, not a per-call-site difference: these two
      // spawns are for two different jobs, so it is excluded from the diff.
      delete queuedKeyed.DCLI_JOB_ID;
      const submitKeyed = { ...submitEnv };
      delete submitKeyed.DCLI_JOB_ID;
      assert.strictEqual(submitEnv.DCLI_QUEUE_CLAIM_PATH, undefined,
        'the initial submit must not set DCLI_QUEUE_CLAIM_PATH');
      assert.deepStrictEqual(queuedKeyed, submitKeyed,
        'the two spawn paths must pass an identical environment except DCLI_QUEUE_CLAIM_PATH');
      assert.strictEqual(queuedEnv.DCLI_JOB_ID, 'j-queued');
      assert.strictEqual(claimValue, claimPath,
        'the queued relaunch must pass the claim path as DCLI_QUEUE_CLAIM_PATH');

      assert.strictEqual(submitEnv.DCLI_WORKER, '1');
      assert.strictEqual(submitEnv.DCLI_STATE_ROOT, dir);
      assert.strictEqual(submitEnv.DCLI_BACKEND, 'fake');
      assert.strictEqual(submitEnv.DCLI_JOB_ID, 'j-submit');
      assert.strictEqual(submitEnv.DCLI_REPO_KEY, REPO_KEY);
      assert.strictEqual(submitEnv.DCLI_REPO_ROOT, process.cwd());
      assert.strictEqual(submitEnv.DCLI_WORKER_HARD_TIMEOUT_MS, '60000');
      console.log('PASS: the two spawn paths pass an identical env except DCLI_QUEUE_CLAIM_PATH');
    } finally {
      restore();
      if (previousCaptureEnv === undefined) delete process.env.WSPAWN_CAPTURE;
      else process.env.WSPAWN_CAPTURE = previousCaptureEnv;
      for (const child of children) await killAndVerify(child);
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Launch identity is persisted before the child can begin work, on the
  //    queued path too (criterion D, ticket 84's ordering). The child is
  //    blocked in its preload — worker.js has not run — and the identity is
  //    already durable, named from 'queued'.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    const preload = path.join(dir, 'block-start.js');
    fs.writeFileSync(preload, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);\n', 'utf8');
    const restore = withNodeOptions(preload);
    let child = null;
    try {
      const store = new JobStore({ stateRoot: dir });
      seedJob(store, 'j-order');
      const claimPath = path.join(dir, 'queue', 'j-order.launching-test.json');
      const spawned = spawnWorker({
        store, stateRoot: dir, backend: 'fake', jobId: 'j-order',
        repoKey: REPO_KEY, repoRoot: process.cwd(), hardTimeoutSec: 60,
        executionToken: 'tok-order', queueClaimPath: claimPath,
      });
      child = spawned.child;

      const status = store.readStatus({ repoKey: REPO_KEY, jobId: 'j-order' });
      assert.strictEqual(status.worker_pid, child.pid,
        'launch identity must be persisted before the child can begin work');
      assert.ok(String(status.worker_identity).startsWith(child.pid + ';'),
        'worker_identity must name the child pid');
      assert.strictEqual(status.execution_token, 'tok-order',
        'the execution token must be persisted with the identity');

      const journal = fs.readFileSync(path.join(store.getJobDir(REPO_KEY, 'j-order'), 'journal.jsonl'), 'utf8');
      const launchLine = journal.split('\n').find(l => l.includes('"execution_token":"tok-order"'));
      assert.ok(launchLine && launchLine.includes('"from":"queued"'),
        'the queued relaunch must record the launch from "queued"');

      await spawned.launched;
      await killAndVerify(child);
      child = null;
      console.log('PASS: launch identity persisted before the child can work, queued path');
    } finally {
      restore();
      if (child) await killAndVerify(child);
      clean(dir);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. End-to-end queued relaunch: a real worker finishes, releaseSlot dequeues
  //    a queued job, the setSpawnWorker callback spawns the replacement through
  //    the module, and that child receives the claim path and runs the job to
  //    completion.
  // ---------------------------------------------------------------------------
  {
    const dir = tmpDir();
    const capture = path.join(dir, 'capture.jsonl');
    const preload = path.join(dir, 'capture-env.js');
    fs.writeFileSync(preload, capturePreloadBody(false), 'utf8');
    const restore = withNodeOptions(preload);
    const previousCaptureEnv = process.env.WSPAWN_CAPTURE;
    process.env.WSPAWN_CAPTURE = capture;
    let worker = null;
    try {
      const store = new JobStore({ stateRoot: dir });
      seedJob(store, 'running-1');
      seedJob(store, 'queued-1');
      const admission = new AdmissionController({ stateRoot: dir, backendLimits: { fake: 5 } });
      admission.enqueueJob('fake', 'queued-1', {
        repoKey: REPO_KEY, repoRoot: process.cwd(), hardTimeoutMs: 60000,
        executionToken: 'tok-queued-1',
      });

      const { spawn } = require('child_process');
      worker = spawn(process.execPath, [path.resolve(__dirname, '..', '..', 'core', 'commands', 'worker.js')], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
          ...process.env,
          DCLI_WORKER: '1',
          DCLI_STATE_ROOT: dir,
          DCLI_BACKEND: 'fake',
          DCLI_JOB_ID: 'running-1',
          DCLI_REPO_KEY: REPO_KEY,
          DCLI_REPO_ROOT: process.cwd(),
          DCLI_WORKER_HARD_TIMEOUT_MS: '60000',
        },
      });

      const deadline = Date.now() + 30000;
      let envLine = null;
      while (Date.now() < deadline) {
        envLine = readCapture(capture).find(l => l.DCLI_JOB_ID === 'queued-1');
        if (envLine) break;
        sleep(50);
      }
      assert.ok(envLine, 'the queued relaunch must spawn a real worker child');
      assert.ok(envLine.DCLI_QUEUE_CLAIM_PATH && envLine.DCLI_QUEUE_CLAIM_PATH.includes('.launching-'),
        `the relaunched worker must receive the queue claim path: ${envLine.DCLI_QUEUE_CLAIM_PATH}`);
      assert.strictEqual(envLine.DCLI_BACKEND, 'fake');
      assert.strictEqual(envLine.DCLI_REPO_KEY, REPO_KEY);
      assert.strictEqual(envLine.DCLI_REPO_ROOT, process.cwd());
      assert.strictEqual(envLine.DCLI_WORKER_HARD_TIMEOUT_MS, '60000');

      const doneDeadline = Date.now() + 30000;
      let status = null;
      while (Date.now() < doneDeadline) {
        try {
          status = store.readStatus({ repoKey: REPO_KEY, jobId: 'queued-1' });
        } catch {}
        if (status && status.state === 'done') break;
        sleep(50);
      }
      assert.strictEqual(status && status.state, 'done', 'the relaunched queued job must run to completion');
      console.log('PASS: queued relaunch runs through the one worker spawn path');
    } finally {
      restore();
      if (previousCaptureEnv === undefined) delete process.env.WSPAWN_CAPTURE;
      else process.env.WSPAWN_CAPTURE = previousCaptureEnv;
      if (worker) await killAndVerify(worker);
      clean(dir);
    }
  }
}

main().catch(err => {
  console.error('FATAL:', err.stack || err.message);
  process.exit(1);
});
