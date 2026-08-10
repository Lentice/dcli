// @suite quick
// Covers the server module's non-happy-path start() (ticket 100): the startup
// sentinel must reject with the real reason, the server process must be
// killed, and no half-initialized state may survive.
//
// Every adapter's Start() used to open with `if (this._testMode) { ...; return }`,
// so the ~110 lines below that guard were executed by nothing in the suite.
// That blind spot is what let a `ReferenceError: child is not defined` ship in
// the codex adapter and break every job. The failure path is the reachable
// non-test-mode assertion: pointing the binary at cmd.exe makes the child exit
// immediately, which trips the premature-exit branch fast instead of burning
// the 30s startup budget.
const assert = require('node:assert');
const { assertRealFailure } = require('../../helpers/assert-failure');

async function main() {

// ===========================================================================
// 1. A server that dies during startup surfaces the real reason, kills the
//    child, and leaves no half-initialized state
// ===========================================================================
{
  const { OpencodeServer } = require('../../../adapters/opencode/server');
  const server = new OpencodeServer({});

  const savedPath = process.env.OPENCODE_PATH;
  // process.execPath, not cmd.exe: cmd.exe with unrecognized switches starts an
  // interactive shell that never exits, which waits out the whole 30s sentinel.
  // node treats opencode's `serve` argument as a missing script and dies at once,
  // which is the premature-exit branch under test.
  process.env.OPENCODE_PATH = process.execPath;

  const startedAt = process.hrtime.bigint();
  let error;
  try {
    await server.start({ canonicalDir: null, opencodePath: process.execPath });
  } catch (err) {
    error = err;
  } finally {
    if (savedPath === undefined) delete process.env.OPENCODE_PATH;
    else process.env.OPENCODE_PATH = savedPath;
  }

  // The failure must be the *real* one, not a crash in our own code
  // masquerading as a backend failure.
  assertRealFailure(
    error,
    { match: /exited prematurely|startup timed out|ENOENT|EINVAL/i },
    'Start with a server that never binds a port'
  );

  // It must reject on the observed exit, not by burning the full startup
  // budget -- a dead worker has to fail fast (AGENTS.md: startup sentinels
  // need slack and a fast-fail).
  const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
  assert.ok(elapsedMs < server.startupTimeoutMs,
    `Dead server must fail fast, not wait out the ${server.startupTimeoutMs}ms sentinel (took ${elapsedMs}ms)`);

  // Proof it got past spawn and recorded launch identity before failing —
  // identity must be captured the instant the process exists, so that a later
  // reconciliation can prove death.
  assert.ok(server.process, 'server.process must be retained for teardown');
  assert.strictEqual(typeof server.pid, 'number', 'launch pid must be recorded');
  assert.ok(server.creationTime, 'creation time must be recorded with the pid');
  assert.ok(server.imagePath, 'image path must be recorded with the pid');
  assert.ok(server.executionToken, 'execution token must be minted for proof of ownership');

  // No half-initialized transport state.
  assert.strictEqual(server.port, null,
    'port must stay null when startup failed');
  assert.strictEqual(server.baseUrl, null,
    'baseUrl must stay null when startup failed');

  // The child must be dead, not leaked. A leaked fixture server poisons every
  // later test on the machine.
  assert.ok(server.process.killed || server.process.exitCode !== null,
    'server process must be killed or already exited after a failed start');

  try { await server.dispose(); } catch {}

  console.log('PASS: opencode server start fails fast with the real reason and kills the child');
}

// ===========================================================================
// 2. The server password is never mirrored into a DCLI_* variable
//    OPENCODE_SERVER_PASSWORD is not ours to name, and every DCLI_* knob is a
//    process-global hidden input. Assert on the real spawn path, since that is
//    the only place the child environment is actually built.
// ===========================================================================
{
  const { OpencodeServer } = require('../../../adapters/opencode/server');
  const server = new OpencodeServer({});

  const savedPath = process.env.OPENCODE_PATH;
  // process.execPath, not cmd.exe: cmd.exe with unrecognized switches starts an
  // interactive shell that never exits, which waits out the whole 30s sentinel.
  // node treats opencode's `serve` argument as a missing script and dies at once,
  // which is the premature-exit branch under test.
  process.env.OPENCODE_PATH = process.execPath;

  try {
    await server.start({ canonicalDir: null, opencodePath: process.execPath });
  } catch {
    // Expected -- node is not an opencode server.
  } finally {
    if (savedPath === undefined) delete process.env.OPENCODE_PATH;
    else process.env.OPENCODE_PATH = savedPath;
  }

  const password = server.password;
  assert.ok(password, 'a per-job password must have been generated');

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DCLI_')) {
      assert.notStrictEqual(value, password,
        `password must never be mirrored into ${key}`);
    }
  }
  assert.strictEqual(process.env.OPENCODE_SERVER_PASSWORD, undefined,
    'the password must not be written into the parent environment');

  try { await server.dispose(); } catch {}

  console.log('PASS: opencode server password stays out of the parent env and DCLI_* names');
}

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
