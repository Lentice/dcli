const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

let _cachedRoot = null;

function getStateRoot() {
  if (_cachedRoot !== null) return _cachedRoot;

  if (process.env.DCLI_STATE_ROOT) {
    _cachedRoot = process.env.DCLI_STATE_ROOT;
    return _cachedRoot;
  }

  const platform = process.platform;
  if (platform === 'win32') {
    _cachedRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'dcli');
  } else if (platform === 'darwin') {
    _cachedRoot = path.join(os.homedir(), 'Library', 'Application Support', 'dcli');
  } else {
    _cachedRoot = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'dcli');
  }

  return _cachedRoot;
}

function resetCache() {
  _cachedRoot = null;
}

function ensureStateRoot(rootPath) {
  const target = rootPath || getStateRoot();

  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }

  _setOwnerOnlyAcls(target);
}

function _setOwnerOnlyAcls(dirPath) {
  if (process.platform === 'win32') {
    try {
      const whoami = spawnSync('whoami', [], { timeout: 5000, encoding: 'utf8', windowsHide: true });
      const user = whoami.stdout ? whoami.stdout.trim() : process.env.USERNAME || '';
      if (user) {
        spawnSync('icacls', [
          dirPath,
          '/inheritance:r',
          '/grant', `${user}:(OI)(CI)F`,
        ], { timeout: 5000, windowsHide: true });
      }
    } catch {
    }
  } else {
    try {
      fs.chmodSync(dirPath, 0o700);
    } catch {
    }
  }
}

function getStateRootAcl(target) {
  if (!target && !_cachedRoot) return null;
  const p = target || _cachedRoot;
  if (!fs.existsSync(p)) return null;

  if (process.platform === 'win32') {
    try {
      const result = spawnSync('icacls', [p], { timeout: 5000, encoding: 'utf8', windowsHide: true });
      return result.stdout || null;
    } catch {
      return null;
    }
  }

  try {
    const stat = fs.statSync(p);
    const mode = stat.mode & 0o777;
    return `0${mode.toString(8)}`;
  } catch {
    return null;
  }
}

module.exports = { getStateRoot, resetCache, ensureStateRoot, getStateRootAcl };
