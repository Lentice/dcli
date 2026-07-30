// @suite full
// @serial  spawns worker processes with timed-out lifecycle
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { JobStore } = require(path.join(ROOT, 'core', 'job-store'));
const { isProcessAlive } = require(path.join(ROOT, 'core', 'process-identity'));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-ht-test-'));
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function spawnWorkerAndWait(stateRoot, backend, jobId, repoKey, repoRoot, hardTimeoutMs, timeoutMs) {
  const workerScript = path.resolve(__dirname, '..', '..', 'core', 'commands', 'worker.js');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerScript], {
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

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const killTimer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
      reject(new Error(`Worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(killTimer);
      resolve({ exitCode: code, stdout, stderr });
    });

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

async function main() {

// ===========================================================================
// 1. Worker with hanging Observe is killed by hard timeout
//    A FakeAdapter whose Observe blocks forever (simulating a hung backend)
//    must be terminated by the hard timeout, reaching timed_out (exit 24).
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = new JobStore({ stateRoot: dir });
    const repoKey = 'test';
    const jobId = 'ht-test-1';
    const repoRoot = dir;

    store.createJob({
      jobId, repoKey, repoRoot,
      backend: 'fake',
      backendVersion: '1.0.0',
      adapterVersion: '1.0.0',
      mode: 'submit',
      access: 'read-only',
      hardTimeoutSec: 1,
    });

    const jobDir = store.getJobDir(repoKey, jobId);

    fs.writeFileSync(path.join(jobDir, 'prompt.txt'), 'test prompt', 'utf8');
    fs.writeFileSync(path.join(jobDir, 'params.json'), JSON.stringify({
      canonicalDir: repoRoot,
      model: null,
      access: 'read-only',
      reasoningEffort: null,
      variant: null,
      effort: null,
      mode: 'run',
      hardTimeoutMs: 1000,
      _adapterScript: {
        facts: [
          { type: 'started', backend_pid: 99999 },
          { type: 'assistant_text', text: 'partial' },
        ],
        exitCode: 0,
        declaredRungs: ['hard_kill'],
        behaviors: {
          hangForever: true,
          hangAfter: 'assistant_text',
        },
      },
    }, null, 2), 'utf8');

    const start = Date.now();
    const { exitCode } = await spawnWorkerAndWait(
      dir, 'fake', jobId, repoKey, repoRoot, 1000, 30000
    );
    const elapsed = Date.now() - start;

    assert.strictEqual(exitCode, 24,
      `Worker must exit 24 (timed_out), got ${exitCode}`);
    assert.ok(elapsed < 30000,
      `Hard timeout must complete within 30s, took ${elapsed}ms`);

    const status = store.readStatus({ repoKey, jobId });
    assert.strictEqual(status.state, 'timed_out',
      `Job state must be timed_out, got ${status.state}`);
    assert.strictEqual(status.failure_reason, 'hard_timeout',
      `failure_reason must be hard_timeout, got ${status.failure_reason}`);

    console.log('PASS: Worker with hanging Observe is killed by hard timeout');
  } finally {
    clean(dir);
  }
}

// ===========================================================================
// 2. Short hard timeout terminates before Observe completes
//    With a very short hard timeout (200ms), the worker must exit 24
//    before the adapter yields process_exited, proving the race-based
//    timeout works and the hardTimedOut path is exercised end-to-end.
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = new JobStore({ stateRoot: dir });
    const repoKey = 'test';
    const jobId = 'ht-test-2';
    const repoRoot = dir;

    store.createJob({
      jobId, repoKey, repoRoot,
      backend: 'fake',
      backendVersion: '1.0.0',
      adapterVersion: '1.0.0',
      mode: 'submit',
      access: 'read-only',
      hardTimeoutSec: 1,
    });

    const jobDir = store.getJobDir(repoKey, jobId);

    fs.writeFileSync(path.join(jobDir, 'prompt.txt'), 'test prompt', 'utf8');
    fs.writeFileSync(path.join(jobDir, 'params.json'), JSON.stringify({
      canonicalDir: repoRoot,
      model: null,
      access: 'read-only',
      reasoningEffort: null,
      variant: null,
      effort: null,
      mode: 'run',
      hardTimeoutMs: 200,
      _adapterScript: {
        facts: [
          { type: 'started', backend_pid: 99999 },
          { type: 'assistant_text', text: 'partial' },
        ],
        exitCode: 0,
        declaredRungs: ['hard_kill'],
        behaviors: {
          hangForever: true,
          hangAfter: 'assistant_text',
        },
      },
    }, null, 2), 'utf8');

    const start = Date.now();
    const { exitCode } = await spawnWorkerAndWait(
      dir, 'fake', jobId, repoKey, repoRoot, 200, 30000
    );
    const elapsed = Date.now() - start;

    assert.strictEqual(exitCode, 24,
      `Worker must exit 24 (timed_out), got ${exitCode}`);
    assert.ok(elapsed < 30000,
      `Short hard timeout must complete within 30s, took ${elapsed}ms`);

    const status = store.readStatus({ repoKey, jobId });
    assert.strictEqual(status.state, 'timed_out',
      `Job state must be timed_out, got ${status.state}`);
    assert.strictEqual(status.failure_reason, 'hard_timeout',
      `failure_reason must be hard_timeout, got ${status.failure_reason}`);

    console.log('PASS: Short hard timeout terminates before Observe completes');
  } finally {
    clean(dir);
  }
}

// ===========================================================================
// 3. Default hard timeout is applied when none specified
//    A worker with no DCLI_WORKER_HARD_TIMEOUT_MS env var (or 0) must
//    still have a bounded default applied, not run unbounded.
//    Using a FakeAdapter that hangs, we verify the worker is killed
//    within the default hard timeout window.
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = new JobStore({ stateRoot: dir });
    const repoKey = 'test';
    const jobId = 'ht-test-3';
    const repoRoot = dir;

    store.createJob({
      jobId, repoKey, repoRoot,
      backend: 'fake',
      backendVersion: '1.0.0',
      adapterVersion: '1.0.0',
      mode: 'submit',
      access: 'read-only',
      hardTimeoutSec: null,
    });

    const jobDir = store.getJobDir(repoKey, jobId);

    fs.writeFileSync(path.join(jobDir, 'prompt.txt'), 'test prompt', 'utf8');
    fs.writeFileSync(path.join(jobDir, 'params.json'), JSON.stringify({
      canonicalDir: repoRoot,
      model: null,
      access: 'read-only',
      reasoningEffort: null,
      variant: null,
      effort: null,
      mode: 'run',
      hardTimeoutMs: 0,
      _adapterScript: {
        facts: [
          { type: 'started', backend_pid: 99999 },
          { type: 'assistant_text', text: 'partial' },
        ],
        exitCode: 0,
        declaredRungs: ['hard_kill'],
        behaviors: {
          hangForever: true,
          hangAfter: 'assistant_text',
        },
      },
    }, null, 2), 'utf8');

    // Spawn with DCLI_WORKER_HARD_TIMEOUT_MS=0 (simulating no --hard-timeout-sec)
    // The worker should apply the default from deadlines.js (30 min in prod,
    // but we use DCLI_HARD_TIMEOUT env override to set a short test value).
    const workerScript = path.resolve(__dirname, '..', '..', 'core', 'commands', 'worker.js');

    const start = Date.now();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerScript], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DCLI_WORKER: '1',
          DCLI_STATE_ROOT: dir,
          DCLI_BACKEND: 'fake',
          DCLI_JOB_ID: jobId,
          DCLI_REPO_KEY: repoKey,
          DCLI_REPO_ROOT: repoRoot,
          DCLI_WORKER_HARD_TIMEOUT_MS: '0',
          // Override the default hard timeout to 2 seconds for test speed
          DCLI_HARD_TIMEOUT: '2000',
        },
      });

      let stdout = '';
      let stderr = '';
      let resolved = false;

      const killTimer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
        reject(new Error('Worker timed out after 30s'));
      }, 30000);

      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      child.on('close', (code) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(killTimer);
        resolve({ exitCode: code, stdout, stderr });
      });

      child.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(killTimer);
        reject(err);
      });
    });

    const elapsed = Date.now() - start;

    assert.strictEqual(result.exitCode, 24,
      `Worker must exit 24 (timed_out) when default timeout kills it, got ${result.exitCode}`);
    assert.ok(elapsed < 30000,
      `Default hard timeout must complete within 30s, took ${elapsed}ms`);

    const status = store.readStatus({ repoKey, jobId });
    assert.strictEqual(status.state, 'timed_out',
      `Job state must be timed_out, got ${status.state}`);
    assert.strictEqual(status.failure_reason, 'hard_timeout',
      `failure_reason must be hard_timeout, got ${status.failure_reason}`);

    console.log('PASS: Default hard timeout applied when none specified');
  } finally {
    clean(dir);
  }
}

console.log('\nAll worker hard-timeout tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
