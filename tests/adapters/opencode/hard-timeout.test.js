// @suite full
// @serial  wall-clock deadline assertions, load-sensitive
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OPENCODE_LIVE_SMOKE = process.env.DCLI_OPENCODE_LIVE_SMOKE;

async function main() {
  if (!OPENCODE_LIVE_SMOKE || OPENCODE_LIVE_SMOKE === '0') {
    console.log('SKIP: DCLI_OPENCODE_LIVE_SMOKE not set — hard-timeout test skipped');
    console.log('      Set DCLI_OPENCODE_LIVE_SMOKE=1 to run against a real opencode install.');
    return;
  }

  const opencodePath = resolveOpencode();
  if (!opencodePath) {
    console.log('SKIP: opencode not found on PATH — hard-timeout test skipped');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-hard-timeout-'));
  let adapter;
  let serverPid = null;

  try {
    const { OpencodeAdapter } = require(path.join(ROOT, 'adapters', 'opencode', 'adapter'));
    const { executeRun } = require(path.join(ROOT, 'core', 'commands', 'run'));
    const { JobStore } = require(path.join(ROOT, 'core', 'job-store'));

    adapter = new OpencodeAdapter();
    const store = new JobStore({ stateRoot: tmpDir });

    const startTime = Date.now();

    const output = await executeRun({
      store, adapter,
      repoKey: 'timeout-test',
      repoRoot: tmpDir,
      prompt: 'Write a comprehensive 5000-word technical analysis of the evolution of TypeScript type system features',
      hardTimeoutSec: 5,
      model: 'opencode-go/deepseek-v4-flash',
    });

    const elapsed = Date.now() - startTime;

    assert.ok(elapsed < 30000,
      `Hard timeout run must complete within 30s (5s timeout + slack), took ${elapsed}ms`);

    assert.strictEqual(output.envelope.state, 'timed_out',
      `Expected job state timed_out, got ${output.envelope.state}`);

    serverPid = adapter._backendPid;
    if (serverPid) {
      assertIsDead(serverPid, 'Server process must be killed after hard timeout');
    }

    console.log(`PASS: hard timeout enforced — state='timed_out', elapsed=${elapsed}ms`);

  } finally {
    if (adapter) {
      try { adapter.Dispose({}); } catch {}
      if (serverPid) {
        try { process.kill(serverPid); } catch {}
      }
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function resolveOpencode() {
  if (process.env.OPENCODE_PATH) return process.env.OPENCODE_PATH;
  try {
    const result = spawnSync('where', ['opencode'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (result.status === 0) {
      const line = (result.stdout || '').trim().split('\n')[0].trim();
      if (line) return line;
    }
  } catch {}
  try {
    const result = spawnSync('which', ['opencode'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (result.status === 0) {
      const line = (result.stdout || '').trim().split('\n')[0].trim();
      if (line) return line;
    }
  } catch {}
  return null;
}

function assertIsDead(pid, message) {
  try {
    process.kill(pid, 0);
    assert.fail(`${message}: expected process ${pid} to be gone, but kill(0) succeeded`);
  } catch (err) {
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



main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
