const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

let _cachedRoot = null;

const STATE_ROOT_UNWRITABLE_CODE = 'DCLI_STATE_ROOT_UNWRITABLE';
const STATE_ROOT_WRITE_ERROR_CODES = new Set([
  'EACCES', 'EBUSY', 'EDQUOT', 'EFBIG', 'EISDIR', 'EIO', 'EINVAL',
  'EMFILE', 'ENFILE', 'ENAMETOOLONG', 'ENOSPC', 'ENOTDIR', 'EPERM', 'EROFS',
]);

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

function isStateRootWriteError(err) {
  return Boolean(err && STATE_ROOT_WRITE_ERROR_CODES.has(err.code));
}

function isStateRootUnwritableError(err) {
  return Boolean(err && err.code === STATE_ROOT_UNWRITABLE_CODE);
}

function createStateRootError(rootPath, cause) {
  if (isStateRootUnwritableError(cause)) return cause;
  const target = rootPath || getStateRoot();
  const detail = cause && cause.code
    ? ` (${cause.code}: ${cause.message})`
    : cause && cause.message ? ` (${cause.message})` : '';
  const error = new Error(
    `state root not writable: ${target}. Grant the runtime access or set DCLI_STATE_ROOT to a private, sandbox-writable directory.${detail}`
  );
  error.code = STATE_ROOT_UNWRITABLE_CODE;
  error.reason = 'state_root_unwritable';
  error.failureClass = 'permission_or_sandbox';
  error.exitCode = 15;
  error.stateRoot = target;
  error.cause = cause;
  return error;
}

function toStateRootError(rootPath, cause) {
  if (isStateRootUnwritableError(cause)) return cause;
  return isStateRootWriteError(cause) ? createStateRootError(rootPath, cause) : null;
}

function assertStateRootWritable(rootPath) {
  const target = rootPath || getStateRoot();
  const probe = path.join(target, `.dcli-probe-${process.pid}-${Date.now()}`);
  try {
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
  } catch (err) {
    try { fs.unlinkSync(probe); } catch {}
    throw createStateRootError(target, err);
  }
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

module.exports = {
  getStateRoot,
  resetCache,
  ensureStateRoot,
  assertStateRootWritable,
  createStateRootError,
  isStateRootWriteError,
  isStateRootUnwritableError,
  toStateRootError,
  STATE_ROOT_UNWRITABLE_CODE,
  getStateRootAcl,
};
