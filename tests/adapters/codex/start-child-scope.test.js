// @suite quick
// Regression: `const child = spawn(...)` was declared inside Start()'s
// try block while the stream/exit handler wiring below the block still
// referenced it, so every real (non-test-mode) Start() threw
// `ReferenceError: child is not defined` — i.e. every codex job failed.
//
// Temp-dir leaks are asserted against the exact path the adapter created, never
// against a count of dcli-codex-* entries in the shared os.tmpdir(): the suite
// runs files concurrently, so a global count is another test's state and the
// delta is meaningless.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const { assertRealFailure } = require('../../helpers/assert-failure');

// cmd.exe launched with codex's arguments is a hang-shaped fixture (an
// interactive shell). Teardown runs in a finally in every case below: a leaked
// fixture poisons every later test on the machine.
function teardown(adapter) {
  if (adapter._childProcess) {
    try { adapter._childProcess.kill(); } catch {}
  }
  try { adapter.Dispose({}); } catch {}
}

async function main() {

// ===========================================================================
// 1. A successful spawn must produce a usable handle, not a ReferenceError
// ===========================================================================
{
  const { CodexAdapter } = require('../../../adapters/codex/adapter');
  const adapter = new CodexAdapter({});

  const savedPath = process.env.CODEX_PATH;
  // cmd.exe spawns successfully; it is not codex, but Start() only has to
  // launch the child and wire its streams.
  process.env.CODEX_PATH = process.env.ComSpec || 'cmd.exe';

  let result;
  let error;
  try {
    result = await adapter.Start({});
  } catch (err) {
    error = err;
  } finally {
    if (savedPath === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = savedPath;
  }

  const tmpDir = adapter._tmpDirPath;

  try {
    assert.ok(!error, `Start must not throw on a successful spawn: ${error && error.stack}`);
    assert.ok(!(error instanceof ReferenceError), 'Start must not throw ReferenceError');
    assert.strictEqual(result.handle, 'codex-process');
    assert.strictEqual(typeof result.pid, 'number', 'handle must carry the child pid');
    assert.strictEqual(adapter._processPid, result.pid, '_processPid must match the handle pid');
    assert.ok(adapter._childProcess, '_childProcess must be retained for SendPrompt');
    assert.ok(result.resultFile, 'handle must carry the result file path');

    // Stream handlers must be armed before any stdin write (deadlock rule).
    assert.strictEqual(adapter._stdoutClosed, false, 'stdout close tracking must be armed');
    assert.strictEqual(adapter._stderrClosed, false, 'stderr close tracking must be armed');
    assert.ok(adapter._childProcess.stdout.listenerCount('data') > 0,
      'stdout data reader must be armed in Start');
    assert.ok(adapter._childProcess.stderr.listenerCount('data') > 0,
      'stderr data reader must be armed in Start');
    assert.ok(adapter._childProcess.listenerCount('exit') > 0, 'exit handler must be armed');
    assert.ok(adapter._childProcess.listenerCount('error') > 0, 'error handler must be armed');
  } finally {
    teardown(adapter);
  }

  assert.ok(tmpDir, 'Start must have created a temp dir');
  assert.ok(!fs.existsSync(tmpDir), `Dispose must remove its own temp dir: ${tmpDir}`);

  console.log('PASS: Start wires the spawned child and returns a usable handle');
}

// ===========================================================================
// 2. A genuinely failing spawn cleans up its temp dir and rethrows the real
//    spawn error — not a ReferenceError masking it
// ===========================================================================
{
  const { CodexAdapter } = require('../../../adapters/codex/adapter');
  const adapter = new CodexAdapter({});

  const savedPath = process.env.CODEX_PATH;
  // A directory is not executable, so this forces a spawn failure.
  process.env.CODEX_PATH = os.tmpdir();

  let error;
  try {
    await adapter.Start({});
  } catch (err) {
    error = err;
  } finally {
    if (savedPath === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = savedPath;
  }

  const tmpDir = adapter._tmpDirPath;

  try {
    if (error) {
      assertRealFailure(error, {}, 'Start with a non-executable CODEX_PATH');
      assert.strictEqual(adapter._tmpDirPath, null,
        '_tmpDirPath must be cleared when Start fails synchronously');
    }
    // If spawn happened to succeed on this host, that is acceptable — the
    // assertion that matters is that no ReferenceError was raised.
  } finally {
    teardown(adapter);
  }

  if (tmpDir) {
    assert.ok(!fs.existsSync(tmpDir), `temp dir must not survive: ${tmpDir}`);
  }

  console.log('PASS: failing Start surfaces the real error and leaks no temp dir');
}

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
