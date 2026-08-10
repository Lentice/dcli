// @suite quick
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-opencode-version-'));
const binDir = path.join(root, 'bin');
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, 'opencode.exe'), '', 'utf8');
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'opencode-ai', version: '1.18.14' }), 'utf8');

const originalPath = process.env.OPENCODE_PATH;
const originalExecSync = childProcess.execSync;
let execSyncCalled = false;
childProcess.execSync = () => {
  execSyncCalled = true;
  throw new Error('version command must not run');
};
process.env.OPENCODE_PATH = path.join(binDir, 'opencode.exe');

try {
  delete require.cache[require.resolve('../../../adapters/opencode/adapter')];
  const { OpencodeAdapter } = require('../../../adapters/opencode/adapter');
  const version = new OpencodeAdapter().DetectVersion();

  assert.strictEqual(version, '1.18.14', 'version must come from the installed package metadata');
  assert.strictEqual(execSyncCalled, false, 'DetectVersion must not launch the backend CLI');
  console.log('PASS: opencode version detection reads package metadata without spawning the CLI');
} finally {
  childProcess.execSync = originalExecSync;
  if (originalPath === undefined) delete process.env.OPENCODE_PATH;
  else process.env.OPENCODE_PATH = originalPath;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
