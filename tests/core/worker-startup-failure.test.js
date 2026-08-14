// @suite full
// @serial  spawns real workers for the startup-failure paths
//
// Ticket 112 — a detached worker that fails before the attempt driver runs
// used to journal a bare string into `detail.failure` (consumers reading
// `failure.class`/`failure.message` got undefined for every startup failure)
// and exited without writing worker-complete.json, so reconciliation had no
// completion evidence on those paths. Both the structured record and the
// sentinel are asserted here for the two paths that previously skipped them:
// missing params (worker_startup_failed) and a crash inside main
// (worker_crash).
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const { JobStore } = require('../../core/job-store');

const REPO_KEY = 'test';
const WORKER = path.resolve(__dirname, '..', '..', 'core', 'commands', 'worker.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-startup-failure-'));
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Seed a submit-style job with no attempts directory — exactly the state a
// worker that never reached attempt creation finds.
function seedJob(dir, jobId, paramsContent) {
  const store = new JobStore({ stateRoot: dir });
  store.createJob({
    jobId, repoKey: REPO_KEY, repoRoot: process.cwd(),
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'submit', access: 'read-only',
  });
  if (paramsContent !== null) {
    fs.writeFileSync(path.join(store.getJobDir(REPO_KEY, jobId), 'params.json'), paramsContent, 'utf8');
  }
  return store;
}

function runWorker(dir, jobId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], {
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
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('worker did not exit within 30s'));
    }, 30000);
    child.once('close', (code) => { clearTimeout(timer); resolve(code); });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function readSentinel(store, jobId) {
  return JSON.parse(fs.readFileSync(
    path.join(store.getJobDir(REPO_KEY, jobId), 'attempts', '1', 'worker-complete.json'), 'utf8'));
}

async function main() {
  // 1. Missing params.json — the params-read journalFailure path.
  {
    const dir = tmpDir();
    try {
      const store = seedJob(dir, 'startup-1', null);
      const exitCode = await runWorker(dir, 'startup-1');
      assert.strictEqual(exitCode, 1, 'missing params must exit 1');

      const status = store.readStatus({ repoKey: REPO_KEY, jobId: 'startup-1' });
      assert.strictEqual(status.state, 'failed');
      assert.strictEqual(status.failure_reason, 'worker_startup_failed');
      assert.strictEqual(typeof status.failure, 'object',
        `failure must be a structured object, got ${JSON.stringify(status.failure)}`);
      assert.strictEqual(status.failure.class, 'worker_startup_failed',
        'failure.class must name the reason, not undefined');
      assert.ok(status.failure.message && status.failure.message.includes('Cannot read params'),
        `failure.message must describe the problem: ${status.failure.message}`);
      assert.strictEqual(status.failure.source, 'wrapper',
        'failure.source must identify the wrapper as observer');

      const sentinel = readSentinel(store, 'startup-1');
      assert.strictEqual(sentinel.exit_code, 1);
      assert.strictEqual(sentinel.state, 'failed');
      assert.ok(sentinel.finished_at, 'sentinel must record when it was written');
      console.log('PASS: missing params — structured failure and completion sentinel');
    } finally {
      clean(dir);
    }
  }

  // 2. Crash inside main — the top-level catch path.
  {
    const dir = tmpDir();
    try {
      // "null" parses as valid JSON but has no executionToken, so main()
      // throws at `params.executionToken` and rejects into the crash handler.
      const store = seedJob(dir, 'startup-2', 'null');
      const exitCode = await runWorker(dir, 'startup-2');
      assert.strictEqual(exitCode, 1, 'a crashed worker must exit 1');

      const status = store.readStatus({ repoKey: REPO_KEY, jobId: 'startup-2' });
      assert.strictEqual(status.state, 'failed');
      assert.strictEqual(status.failure_reason, 'worker_crash');
      assert.strictEqual(typeof status.failure, 'object',
        `failure must be a structured object, got ${JSON.stringify(status.failure)}`);
      assert.strictEqual(status.failure.class, 'worker_crash',
        'failure.class must name the crash reason, not undefined');
      assert.ok(status.failure.message && status.failure.message.length > 0,
        'failure.message must carry the crash error');
      assert.strictEqual(status.failure.source, 'wrapper');

      const sentinel = readSentinel(store, 'startup-2');
      assert.strictEqual(sentinel.exit_code, 1);
      assert.strictEqual(sentinel.state, 'failed');
      console.log('PASS: worker crash — structured failure and completion sentinel');
    } finally {
      clean(dir);
    }
  }

  // 3. Adapter start failure — the backend never started, so the driver's
  // named worker_launch failure must survive the worker catch and sentinel.
  {
    const dir = tmpDir();
    try {
      const params = {
        canonicalDir: process.cwd(), mode: 'run', access: 'read-only', hardTimeoutMs: 60000,
        _adapterScript: {
          behaviors: { failStart: 'backend executable unavailable' },
          facts: [{ type: 'process_exited', code: 0 }],
        },
      };
      const store = seedJob(dir, 'startup-3', JSON.stringify(params));
      fs.writeFileSync(path.join(store.getJobDir(REPO_KEY, 'startup-3'), 'prompt.txt'), 'hello', 'utf8');
      const exitCode = await runWorker(dir, 'startup-3');
      assert.strictEqual(exitCode, 18, 'adapter start failure must exit 18');

      const status = store.readStatus({ repoKey: REPO_KEY, jobId: 'startup-3' });
      assert.strictEqual(status.state, 'failed');
      assert.strictEqual(status.failure_reason, 'adapter_start_failed');
      assert.strictEqual(status.failure.class, 'worker_launch');

      const sentinel = readSentinel(store, 'startup-3');
      assert.strictEqual(sentinel.exit_code, 18);
      assert.strictEqual(sentinel.state, 'failed');
      console.log('PASS: detached adapter start failure preserves worker_launch and exit 18');
    } finally {
      clean(dir);
    }
  }

  console.log('\nAll worker startup-failure tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
