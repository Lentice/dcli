// @suite full
// @serial  tears down live server process trees
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { OpencodeAdapter } = require('../../../adapters/opencode/adapter');

const OPENCODE_LIVE_SMOKE = process.env.DCLI_OPENCODE_LIVE_SMOKE;

async function main() {
  if (!OPENCODE_LIVE_SMOKE || OPENCODE_LIVE_SMOKE === '0') {
    console.log('SKIP: DCLI_OPENCODE_LIVE_SMOKE not set — server-teardown test skipped');
    console.log('      Set DCLI_OPENCODE_LIVE_SMOKE=1 to run against a real opencode install.');
    return;
  }

  if (!hasOpencode()) {
    console.log('SKIP: opencode not found on PATH — server-teardown test skipped');
    return;
  }

  let adapter;
  let serverPid = null;

  try {
    adapter = new OpencodeAdapter();
    const attempt = {};

    const handle = await adapter.Start(attempt);
    assert.ok(handle && typeof handle === 'object', 'Start() must return a handle');
    assert.ok(typeof handle.serverPid === 'number', 'Start() must return serverPid');
    serverPid = handle.serverPid;
    assert.ok(serverPid > 0, `serverPid must be positive, got ${serverPid}`);

    assertIsAlive(serverPid, 'Server must be alive after Start()');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-teardown-'));
    try {
      adapter.PrepareInvocation(attempt, {
        canonicalDir: tmpDir,
        access: 'read-only',
      });

      await adapter.SendPrompt(attempt, 'Reply with exactly: PONG');

    const facts = [];
      for await (const fact of adapter.Observe(attempt)) {
        facts.push(fact);
      }
      assert.ok(facts.length > 0, 'Must have emitted at least one fact');

      adapter.Dispose(attempt);

      await delay(500);

      assertIsDead(serverPid, 'Server must be dead after Dispose()');

      console.log('PASS: server process verifiably gone after Dispose()');
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }

  } finally {
    if (adapter && serverPid) {
      try {
        adapter.Dispose({});
      } catch {}
      try {
        process.kill(serverPid);
      } catch {}
    }
  }
}

function hasOpencode() {
  if (process.env.OPENCODE_PATH) return true;
  try {
    const r = spawnSync('where', ['opencode'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.status === 0) return true;
  } catch {}
  try {
    const r = spawnSync('which', ['opencode'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.status === 0) return true;
  } catch {}
  return false;
}

function assertIsAlive(pid, message) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    assert.fail(`${message}: expected process ${pid} to exist, but kill(0) threw: ${err.message}`);
  }
}

function assertIsDead(pid, message) {
  try {
    process.kill(pid, 0);
    assert.fail(`${message}: expected process ${pid} to be gone, but kill(0) succeeded`);
  } catch (err) {
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

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
