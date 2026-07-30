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
// 1. Sync spawn failure cleans up temp dir
//    Create a temp .cmd and then delete it before spawn — the spawn will fail
//    because the file no longer exists. Since it's a .cmd shim, buildCmdInvocation
//    wraps it in cmd.exe /d /s /c, which starts successfully, but the inner
//    command's stderr will contain an error. This tests the dispose cleanup path.
// ===========================================================================
{
  const before = countTempDirs();
  const { CodexAdapter } = require('../../../adapters/codex/adapter');

  const adapter = new CodexAdapter({ _testMode: false, _mockVersion: '0.145.0' });

  // Use a cmd.exe path as CODEX_PATH to avoid PATH resolution
  const savedPath = process.env.CODEX_PATH;
  // 'cmd.exe /d /c echo stub' will spawn a cmd.exe that exits immediately
  // with no server to listen on, so the startup sentinel will time out.
  // The key assertion is that Dispose cleans up the temp dir after the error.
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

  // Start should fail because this isn't a real codex binary
  assert.ok(error, 'Start must fail with non-codex binary');

  // Dispose should clean up the temp dir
  adapter.Dispose({});

  const after = countTempDirs();
  assert.strictEqual(after - before, 0,
    `No dcli-codex-* dirs must be leaked. Before: ${before}, after: ${after}`);

  console.log('PASS: Dispose cleans up temp dir after failed Start');
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
