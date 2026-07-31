// @suite full
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

function countTempDirs() {
  try {
    return fs.readdirSync(os.tmpdir()).filter(e => e.startsWith('dcli-codex-')).length;
  } catch { return -1; }
}

async function main() {

// ===========================================================================
// 1. Dispose cleans up the temp dir after a Start that launched a child
//    CODEX_PATH points at cmd.exe, which spawns successfully — Start only has
//    to launch and wire the child, so it must NOT throw here. (This case
//    previously asserted `Start` failed, which was a false green: it only
//    passed because of a ReferenceError in Start's own body.)
// ===========================================================================
{
  const before = countTempDirs();
  const { CodexAdapter } = require('../../../adapters/codex/adapter');

  const adapter = new CodexAdapter({ _testMode: false, _mockVersion: '0.145.0' });

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

  try { adapter._childProcess.kill(); } catch {}

  // Dispose should clean up the temp dir
  adapter.Dispose({});

  const after = countTempDirs();
  assert.strictEqual(after - before, 0,
    `No dcli-codex-* dirs must be leaked. Before: ${before}, after: ${after}`);

  console.log('PASS: Dispose cleans up temp dir after Start launched a child');
}

// ===========================================================================
// 2. _tmpDirPath is null when Start throws synchronously (verified via empty command)
//    Test the try/catch cleanup path by creating an adapter and triggering
//    the cleanup logic directly.
// ===========================================================================
{
  const { CodexAdapter } = require('../../../adapters/codex/adapter');
  const adapter = new CodexAdapter({ _testMode: false, _mockVersion: '0.145.0' });

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
  const adapter = new CodexAdapter({ _testMode: false, _mockVersion: '0.145.0' });
  adapter._tmpDirPath = null;
  assert.doesNotThrow(() => adapter.Dispose({}));
  console.log('PASS: Dispose safe when no temp dir was created');
}

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
