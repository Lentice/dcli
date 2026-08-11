// @suite full
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

async function main() {

// ===========================================================================
// 1. Dispose cleans up the temp dir after a Start that launched a child
//    CODEX_PATH points at cmd.exe, which spawns successfully — Start only has
//    to launch and wire the child, so it must NOT throw here. (This case
//    previously asserted `Start` failed, which was a false green: it only
//    passed because of a ReferenceError in Start's own body.)
//
//    The leak is asserted against the exact path the adapter created. Counting
//    dcli-codex-* entries in the shared os.tmpdir() and comparing a delta does
//    not work: the suite runs files concurrently, so the count includes other
//    tests' directories appearing and disappearing mid-case.
// ===========================================================================
{
  const { CodexAdapter } = require('../../../adapters/codex/adapter');

  const adapter = new CodexAdapter({});

  // Use a cmd.exe path as CODEX_PATH to avoid PATH resolution
  const savedPath = process.env.CODEX_PATH;
  process.env.CODEX_PATH = process.env.ComSpec || 'cmd.exe';

  let error;
  try {
    await adapter.Start({});
  } catch (err) {
    error = err;
  } finally {
    if (savedPath === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = savedPath;
  }

  assert.ok(!error, `Start must not throw when the spawn succeeds: ${error && error.stack}`);
  assert.ok(adapter._tmpDirPath, 'Start must have created a temp dir to clean up');

  const tmpDir = adapter._tmpDirPath;
  assert.ok(fs.existsSync(tmpDir), `temp dir must exist after Start: ${tmpDir}`);

  // Teardown in a finally: cmd.exe with codex's arguments is a hang-shaped
  // fixture, and a leaked one poisons every later test on the machine.
  try {
    if (adapter._childProcess) {
      try { adapter._childProcess.kill(); } catch {}
    }
  } finally {
    // Dispose is async since ticket 102 (it awaits the shared
    // terminateProcessTree), so the temp-dir assertion awaits it.
    await adapter.Dispose({});
  }

  assert.ok(!fs.existsSync(tmpDir), `Dispose must remove its own temp dir: ${tmpDir}`);

  console.log('PASS: Dispose cleans up temp dir after Start launched a child');
}

// ===========================================================================
// 2. fs.rmSync + null assignment behaves as the catch block expects.
//    NOTE: this exercises the cleanup *idiom*, not the adapter -- it
//    re-implements the catch block rather than calling into it, so it cannot
//    catch a regression in Start(). The real sync-failure path is covered by
//    start-child-scope.test.js case 2, which drives Start() itself.
// ===========================================================================
{
  const { CodexAdapter } = require('../../../adapters/codex/adapter');
  const adapter = new CodexAdapter({});

  // Directly test the cleanup: create temp dir, then simulate sync failure
  adapter._tmpDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-codex-'));
  const tmpDir = adapter._tmpDirPath;
  assert.ok(fs.existsSync(tmpDir), 'temp dir must exist before cleanup');

  // Simulate what happens in the catch block
  try { fs.rmSync(adapter._tmpDirPath, { recursive: true, force: true }); } catch {}
  adapter._tmpDirPath = null;

  assert.strictEqual(adapter._tmpDirPath, null,
    '_tmpDirPath must be null after cleanup');
  assert.ok(!fs.existsSync(tmpDir),
    `Temp dir must be removed: ${tmpDir}`);

  console.log('PASS: cleanup of temp dir on sync failure');
}

// ===========================================================================
// 3. Dispose is safe when _tmpDirPath is null
// ===========================================================================
{
  const { CodexAdapter } = require('../../../adapters/codex/adapter');
  const adapter = new CodexAdapter({});
  adapter._tmpDirPath = null;
  assert.doesNotThrow(() => adapter.Dispose({}));
  console.log('PASS: Dispose safe when no temp dir was created');
}

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
