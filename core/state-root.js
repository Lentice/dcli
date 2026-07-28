const path = require('path');
const os = require('os');

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

module.exports = { getStateRoot, resetCache };
