// @suite quick
// Covers the non-test-mode Start() path in adapters/opencode/adapter.js.
//
// Every adapter's Start() opens with `if (this._testMode) { ...; return }`, and
// every existing adapter test sets _testMode, so the ~110 lines below that guard
// were executed by nothing in the suite. That blind spot is what let a
// `ReferenceError: child is not defined` ship in the codex adapter and break
// every job.
//
// opencode differs from the other two backends: Start() launches a *server* and
// then waits on a startup sentinel, so the reachable non-test-mode assertion is
// the failure path -- the sentinel must reject with the real reason, the server
// process must be killed, and no half-initialized state may survive. Pointing
// the binary at cmd.exe makes the child exit immediately, which trips the
// premature-exit branch fast instead of burning the 30s startup budget.
const assert = require('node:assert');

async function main() {

// ===========================================================================
// 1. A server that dies during startup surfaces the real reason, kills the
//    child, and leaves no half-initialized state
// ===========================================================================
{
  const { OpencodeAdapter } = require('../../../adapters/opencode/adapter');
  const adapter = new OpencodeAdapter({ _testMode: false, _mockVersion: '1.18.8' });

  const savedPath = process.env.OPENCODE_PATH;
  // process.execPath, not cmd.exe: cmd.exe with unrecognized switches starts an
  // interactive shell that never exits, which waits out the whole 30s sentinel.
  // node treats opencode's `serve` argument as a missing script and dies at once,
  // which is the premature-exit branch under test.
  process.env.OPENCODE_PATH = process.execPath;

  const startedAt = process.hrtime.bigint();
  let error;
  try {
    await adapter.Start({});
  } catch (err) {
    error = err;
  } finally {
    if (savedPath === undefined) delete process.env.OPENCODE_PATH;
    else process.env.OPENCODE_PATH = savedPath;
  }

  assert.ok(error, 'Start must fail when the server never binds a port');

  // The whole point: the failure must be the *real* one, not a crash in our
  // own code masquerading as a backend failure.
  assert.ok(!(error instanceof ReferenceError),
    `Failure must be the server error, not a ReferenceError: ${error.stack}`);
  assert.ok(!(error instanceof TypeError),
    `Failure must be the server error, not a TypeError: ${error.stack}`);
  assert.match(error.message, /exited prematurely|startup timed out|ENOENT|EINVAL/i,
    `Unexpected failure reason: ${error.message}`);

  // It must reject on the observed exit, not by burning the full startup
  // budget -- a dead worker has to fail fast (AGENTS.md: startup sentinels
  // need slack and a fast-fail).
  const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
  assert.ok(elapsedMs < adapter._startupTimeoutMs,
    `Dead server must fail fast, not wait out the ${adapter._startupTimeoutMs}ms sentinel (took ${elapsedMs}ms)`);

  // Proof it got past spawn and recorded launch identity before failing --
  // identity must be captured the instant the process exists, so that a later
  // reconciliation can prove death.
  assert.ok(adapter._serverProcess, '_serverProcess must be retained for teardown');
  assert.strictEqual(typeof adapter._backendPid, 'number', 'launch pid must be recorded');
  assert.ok(adapter._creationTime, 'creation time must be recorded with the pid');
  assert.ok(adapter._imagePath, 'image path must be recorded with the pid');
  assert.ok(adapter._executionToken, 'execution token must be minted for proof of ownership');

  // No half-initialized transport state.
  assert.strictEqual(adapter._serverPort, null,
    '_serverPort must stay null when startup failed');
  assert.strictEqual(adapter._serverBaseUrl, null,
    '_serverBaseUrl must stay null when startup failed');

  // The child must be dead, not leaked. A leaked fixture server poisons every
  // later test on the machine.
  assert.ok(adapter._serverProcess.killed || adapter._serverProcess.exitCode !== null,
    'server process must be killed or already exited after a failed Start');

  try { adapter.Dispose({}); } catch {}

  console.log('PASS: opencode Start fails fast with the real reason and kills the server');
}

// ===========================================================================
// 2. The server password is never mirrored into a DCLI_* variable
//    OPENCODE_SERVER_PASSWORD is not ours to name, and every DCLI_* knob is a
//    process-global hidden input. Assert on the real spawn path, since that is
//    the only place the child environment is actually built.
// ===========================================================================
{
  const { OpencodeAdapter } = require('../../../adapters/opencode/adapter');
  const adapter = new OpencodeAdapter({ _testMode: false, _mockVersion: '1.18.8' });

  const savedPath = process.env.OPENCODE_PATH;
  // process.execPath, not cmd.exe: cmd.exe with unrecognized switches starts an
  // interactive shell that never exits, which waits out the whole 30s sentinel.
  // node treats opencode's `serve` argument as a missing script and dies at once,
  // which is the premature-exit branch under test.
  process.env.OPENCODE_PATH = process.execPath;

  try {
    await adapter.Start({});
  } catch {
    // Expected -- cmd.exe is not an opencode server.
  } finally {
    if (savedPath === undefined) delete process.env.OPENCODE_PATH;
    else process.env.OPENCODE_PATH = savedPath;
  }

  const password = adapter._password;
  assert.ok(password, 'a per-job password must have been generated');

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DCLI_')) {
      assert.notStrictEqual(value, password,
        `password must never be mirrored into ${key}`);
    }
  }
  assert.strictEqual(process.env.OPENCODE_SERVER_PASSWORD, undefined,
    'the password must not be written into the parent environment');

  try { adapter.Dispose({}); } catch {}

  console.log('PASS: opencode server password stays out of the parent env and DCLI_* names');
}

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
