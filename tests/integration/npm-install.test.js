// @suite full
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DEFAULT_TIMEOUT } = require('../run-tests');
const { assertSpawnStatus } = require('../helpers/spawn-assert');

const repoRoot = path.resolve(__dirname, '../..');
const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-npm-install-'));
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-npm-cache-'));

try {
  const npm = process.platform === 'win32'
    ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : 'npm';
  const npmArgs = [
    'install', '--global', '--prefix', prefix, '--cache', cache, '--ignore-scripts', '--install-links', repoRoot,
  ];
  const result = spawnSync(process.platform === 'win32' ? process.execPath : npm,
    process.platform === 'win32' ? [npm, ...npmArgs] : npmArgs,
    { encoding: 'utf8', timeout: DEFAULT_TIMEOUT, windowsHide: true });
  assertSpawnStatus(result, 0, `npm install failed: ${result.stderr}`, DEFAULT_TIMEOUT);

  const installedPackage = path.join(prefix, 'node_modules', 'dcli');
  assert.ok(!fs.lstatSync(installedPackage).isSymbolicLink(),
    'global install must copy dcli instead of linking the repository');

  const helperRelPaths = [
    path.join('native', 'windows-job-helper', 'bin', 'Release', 'contain.exe'),
    path.join('native', 'windows-job-helper', 'bin', 'Debug', 'net10.0', 'contain.exe'),
  ];
  for (const rel of helperRelPaths) {
    const sourceHelper = path.join(repoRoot, rel);
    if (!fs.existsSync(sourceHelper)) continue;
    const installedHelper = path.join(installedPackage, rel);
    assert.ok(fs.existsSync(installedHelper), `packed install must keep built helper: ${rel}`);
    assert.ok(fs.readFileSync(installedHelper).equals(fs.readFileSync(sourceHelper)),
      `installed helper must byte-match the checkout: ${rel}`);
  }

  const help = spawnSync(process.execPath, [
    path.join(installedPackage, 'cli', 'dcli-opencode.js'), '--help',
  ], { encoding: 'utf8', timeout: DEFAULT_TIMEOUT, windowsHide: true });
  assertSpawnStatus(help, 0, `installed shim failed: ${help.stderr}`, DEFAULT_TIMEOUT);
  assert.match(help.stdout, /opencode/, 'installed shim must execute from the copied package');
} finally {
  fs.rmSync(prefix, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
}

console.log('PASS: npm global install is independent of the source checkout');
