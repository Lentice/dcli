// @suite full
// Ticket 102, criteria C/D/G. The Unix containment rung: a backend spawned
// `detached` lives in its own process group, and terminateProcessTree must
// kill the GROUP — the backend's descendants included — with SIGTERM → bounded
// grace → SIGKILL. These tests drive real process groups with plain Node
// fixtures, so no backend binary is needed.
//
// POSIX-only by construction (ticket 91 discipline): on Windows the suite must
// name the skip out loud, never sit silently green.
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'process-group-child.js');
const GRACE_MS = 400;
const DEAD_POLL_MS = 100;
const DEAD_DEADLINE_MS = 5000;
const READ_DEADLINE_MS = 10000;

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function waitUntilDead(pid) {
  const deadline = Date.now() + DEAD_DEADLINE_MS;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise(r => setTimeout(r, DEAD_POLL_MS));
  }
  return !isAlive(pid);
}

function spawnFixture(extraEnv) {
  return spawn(process.execPath, [FIXTURE], {
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
    env: { ...process.env, ...(extraEnv || {}) },
  });
}

function readGrandchildPid(child) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('fixture did not print GRANDCHILD_PID in time')), READ_DEADLINE_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const m = buf.match(/GRANDCHILD_PID=(\d+)/);
      if (m) { clearTimeout(timer); resolve(parseInt(m[1], 10)); }
    });
    child.on('exit', () => { clearTimeout(timer); reject(new Error('fixture exited before printing GRANDCHILD_PID')); });
  });
}

// What "terminate the backend" means. Ticket 102 step 1 ran this against
// today's direct-child SIGKILL to prove the grandchild survives (the ticket's
// evidence, recorded in Notes); the shipped version points at the shared
// group-termination helper in adapters/shared/process-lifecycle.js.
async function terminate(child, opts) {
  const { terminateProcessTree } = require('../../adapters/shared/process-lifecycle');
  return terminateProcessTree(child, opts);
}

async function main() {
  if (process.platform === 'win32') {
    console.log('SKIPPED (POSIX-only): process-group containment tests — Windows termination stays at rung 0 (direct-child kill, ticket 102 non-goal / ticket 103); ticket 91 discipline requires naming the skip.');
    return;
  }

  // Criterion C — the grandchild of the backend dies with the group.
  {
    const child = spawnFixture();
    try {
      const gcPid = await readGrandchildPid(child);
      assert.ok(isAlive(gcPid), `grandchild ${gcPid} must be alive before termination`);
      const result = await terminate(child, { graceMs: GRACE_MS });
      assert.ok(await waitUntilDead(gcPid),
        `grandchild ${gcPid} must be dead after the rung — a direct-child kill would leave it reparented to init`);
      assert.ok(await waitUntilDead(child.pid), 'backend child must be dead after the rung');
      assert.strictEqual(result.kind, 'process-group');
      assert.strictEqual(result.degraded, false);
      console.log(`PASS: grandchild (${gcPid}) died with the group`);
    } finally {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
  }

  // Criterion D — SIGTERM first; SIGKILL only after a bounded grace; a
  // SIGTERM-ignoring fixture is still terminated, and the wait is bounded.
  {
    const child = spawnFixture({ DCLI_IGNORE_SIGTERM: '1' });
    try {
      // The fixture registers its SIGTERM handler before spawning the
      // grandchild and printing the marker, so this line also proves the
      // handler is in place before we signal — a SIGTERM that lands during
      // Node startup kills the fixture by default and is not a grace test.
      await readGrandchildPid(child);
      const started = Date.now();
      const result = await terminate(child, { graceMs: GRACE_MS });
      const elapsed = Date.now() - started;
      assert.strictEqual(result.kind, 'process-group');
      assert.strictEqual(result.degraded, false);
      assert.strictEqual(result.escalated, true,
        'SIGTERM is ignored by the fixture, so the helper must have escalated to SIGKILL');
      assert.ok(elapsed < GRACE_MS + 3000, `grace wait must be bounded, took ${elapsed}ms`);
      assert.ok(await waitUntilDead(child.pid), 'SIGTERM-ignoring child must be dead after the grace escalation');
      console.log(`PASS: SIGTERM-ignoring child killed after bounded grace (escalated, ${elapsed}ms)`);
    } finally {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
  }

  // ESRCH — terminating an already-exited group is success, not an error.
  {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', detached: true });
    await new Promise(resolve => child.on('exit', resolve));
    const result = await terminate(child, { graceMs: GRACE_MS });
    assert.strictEqual(result.kind, 'process-group');
    assert.strictEqual(result.degraded, false);
    console.log('PASS: terminating an already-exited group returns success (ESRCH)');
  }
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
