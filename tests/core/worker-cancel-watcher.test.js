// @suite full
// @serial  spawns worker processes with cancel.request detection
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { JobStore } = require(path.join(ROOT, 'core', 'job-store'));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-cw-test-'));
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function spawnTestWorker(stateRoot, backend, jobId, repoKey, repoRoot, hardTimeoutMs, timeoutMs) {
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
// 1. Worker self-cancels when cancel.request is written while running
// ===========================================================================
{
  const dir = tmpDir();
  try {
    const store = new JobStore({ stateRoot: dir });
    const repoKey = 'test';
    const jobId = 'cw-test-1';
    const repoRoot = dir;

    store.createJob({
      jobId, repoKey, repoRoot,
      backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
      mode: 'submit', access: 'read-only',
    });

    const jobDir = store.getJobDir(repoKey, jobId);

    fs.writeFileSync(path.join(jobDir, 'prompt.txt'), 'test prompt', 'utf8');
    fs.writeFileSync(path.join(jobDir, 'params.json'), JSON.stringify({
      canonicalDir: repoRoot,
      model: null, access: 'read-only',
      reasoningEffort: null, variant: null, effort: null,
      mode: 'run', hardTimeoutMs: 0,
      _adapterScript: {
        facts: [
          { type: 'started', backend_pid: 99999 },
          { type: 'assistant_text', text: 'partial' },
        ],
        exitCode: 0, declaredRungs: ['hard_kill'],
        // Use interruptible wait so RequestCancel breaks the hang
        behaviors: { hangAfter: 'assistant_text' },
      },
    }, null, 2), 'utf8');

    // Start worker and wait briefly, then write cancel.request
    const workerPromise = spawnTestWorker(dir, 'fake', jobId, repoKey, repoRoot, 300000, 60000);

    // Wait for worker to start and enter observe loop, then write cancel.request
    await new Promise(r => setTimeout(r, 3000));
    fs.writeFileSync(path.join(jobDir, 'cancel.request'), JSON.stringify({
      requested_at: new Date().toISOString(), job_id: jobId,
    }), 'utf8');

    const { exitCode } = await workerPromise;

    assert.strictEqual(exitCode, 0,
      `Worker must exit 0 on self-cancel, got ${exitCode}`);

    const status = store.readStatus({ repoKey: 'test', jobId });
    assert.strictEqual(status.state, 'cancelled',
      `Job must be cancelled after cancel.request write, got ${status.state}`);

    console.log('PASS: Worker self-cancels on cancel.request');
  } finally {
    clean(dir);
  }
}

console.log('\nAll cancel-watcher tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
