const fs = require('fs');
const path = require('path');
const { getOwnIdentity, generateExecutionToken, isProcessAlive, isSameProcessAlive } = require('./process-identity');

const LOCK_SCOPES = Object.freeze({
  ATTEMPT: 'attempt',
  JOB_INDEX: 'job-index',
  WORKTREE: 'worktree',
  APPLY: 'apply',
  CLEANUP: 'cleanup',
  SERVER_LIFECYCLE: 'server-lifecycle',
  JOB_LEASE: 'job-lease',
  PER_JOB: 'per-job',
});

const LOCK_EXIT_CODE = 17;

const DEFAULT_TIMEOUT_MS = 10000;

const BACKOFF_MIN_MS = 10;
const BACKOFF_MAX_MS = 200;

const SLEEP_SAB = new Int32Array(new SharedArrayBuffer(4));

function synchronousSleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(SLEEP_SAB, 0, 0, Math.max(1, ms));
}

function getBackoffDelay(remaining) {
  return Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, Math.floor(remaining / 10)));
}

/**
 * @param {string} key
 * @returns {string}
 */
function sanitizeKey(key) {
  return String(key).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

class LockManager {
  constructor(options = {}) {
    const stateRoot = require('./state-root').getStateRoot();
    this._lockDir = options.lockDir || path.join(stateRoot, 'locks');
    this._timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this._heldLocks = new Map();
    this._ownIdentity = getOwnIdentity();
    this._ownToken = generateExecutionToken();
  }

  get lockDir() {
    return this._lockDir;
  }

  get ownToken() {
    return this._ownToken;
  }

  _lockPath(scope, key) {
    const safeKey = sanitizeKey(key);
    return path.join(this._lockDir, `${scope}-${safeKey}.lock`);
  }

  _writeMetadata(lockPath, extra) {
    const metadata = {
      schema_version: 1,
      pid: this._ownIdentity.pid,
      ppid: this._ownIdentity.ppid,
      startTime: this._ownIdentity.startTime,
      imagePath: this._ownIdentity.imagePath,
      hostname: this._ownIdentity.hostname,
      operation: extra && extra.operation ? extra.operation : 'unknown',
      acquiredAt: new Date().toISOString(),
      executionToken: this._ownToken,
    };
    if (extra) {
      for (const k of Object.keys(extra)) {
        if (k !== 'operation' && !metadata.hasOwnProperty(k)) {
          metadata[k] = extra[k];
        }
      }
    }
    fs.writeFileSync(lockPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  }

  _readMetadata(lockPath) {
    try {
      const content = fs.readFileSync(lockPath, 'utf8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Acquire a lock. Blocks up to timeoutMs.
   * @param {string} scope
   * @param {string} key
   * @param {object} [extra]
   * @returns {object} lock handle
   */
  acquire(scope, key, extra) {
    const lockKey = `${scope}:${key}`;
    if (this._heldLocks.has(lockKey)) {
      return this._heldLocks.get(lockKey);
    }

    const lockPath = this._lockPath(scope, key);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    const deadline = Date.now() + this._timeoutMs;
    let lastError = null;

    while (Date.now() < deadline) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        try {
          this._writeMetadata(lockPath, extra);
        } catch (writeErr) {
          try { fs.closeSync(fd); } catch {}
          try { fs.unlinkSync(lockPath); } catch {}
          throw writeErr;
        }
        const lock = {
          scope,
          key,
          lockPath,
          fd,
          released: false,
          acquiredAt: new Date().toISOString(),
          executionToken: this._ownToken,
        };
        this._heldLocks.set(lockKey, lock);
        return lock;
      } catch (err) {
        if (err.code !== 'EEXIST') {
          throw err;
        }
        if (this._isStale(lockPath)) {
          this._quarantine(lockPath);
          continue;
        }
        lastError = err;
        const remaining = deadline - Date.now();
        if (remaining <= BACKOFF_MIN_MS) break;
        const delay = getBackoffDelay(remaining);
        synchronousSleep(delay);
      }
    }

    const error = new Error(
      `Failed to acquire lock ${lockKey}: ${lastError ? lastError.message : 'timeout'}`
    );
    error.exitCode = LOCK_EXIT_CODE;
    throw error;
  }

  /**
   * Non-blocking acquire. Returns lock handle or null.
   * @param {string} scope
   * @param {string} key
   * @param {object} [extra]
   * @returns {object|null}
   */
  tryAcquire(scope, key, extra) {
    const lockKey = `${scope}:${key}`;
    if (this._heldLocks.has(lockKey)) {
      return this._heldLocks.get(lockKey);
    }

    const lockPath = this._lockPath(scope, key);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        this._writeMetadata(lockPath, extra);
      } catch (writeErr) {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(lockPath); } catch {}
        throw writeErr;
      }
      const lock = {
        scope,
        key,
        lockPath,
        fd,
        released: false,
        acquiredAt: new Date().toISOString(),
        executionToken: this._ownToken,
      };
      this._heldLocks.set(lockKey, lock);
      return lock;
    } catch (err) {
      if (err.code === 'EEXIST' && this._isStale(lockPath)) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            this._quarantine(lockPath);
            if (!fs.existsSync(lockPath)) break;
          } catch {
            synchronousSleep(BACKOFF_MIN_MS);
          }
        }
        if (!fs.existsSync(lockPath)) {
          return this.tryAcquire(scope, key, extra);
        }
        return null;
      }
      return null;
    }
  }

  /**
   * Release a held lock.
   * @param {object} lock
   */
  release(lock) {
    if (!lock || lock.released) return;
    lock.released = true;
    const lockKey = `${lock.scope}:${lock.key}`;
    this._heldLocks.delete(lockKey);
    try {
      if (lock.fd !== undefined) {
        fs.closeSync(lock.fd);
      }
    } catch {}
    try {
      if (lock.lockPath) {
        fs.unlinkSync(lock.lockPath);
      }
    } catch {}
  }

  releaseAll() {
    for (const lock of this._heldLocks.values()) {
      this.release(lock);
    }
  }

  /**
   * @param {string} scope
   * @param {string} key
   * @returns {boolean}
   */
  isHeld(scope, key) {
    return this._heldLocks.has(`${scope}:${key}`);
  }

  _isStale(lockPath) {
    try {
      if (!fs.existsSync(lockPath)) return false;
      const meta = this._readMetadata(lockPath);
      if (!meta || !meta.pid) {
        this._quarantine(lockPath);
        return true;
      }

      if (meta.pid === this._ownIdentity.pid) {
        if (meta.executionToken === this._ownToken) {
          return false;
        }
        if (meta.startTime && meta.startTime === this._ownIdentity.startTime) {
          return false;
        }
        return true;
      }

      const alive = isSameProcessAlive({ pid: meta.pid, startTime: meta.startTime, imagePath: meta.imagePath });
      return !alive;
    } catch {
      return false;
    }
  }

  _quarantine(lockPath) {
    const quarantinedPath = lockPath + '.stale';
    try {
      fs.renameSync(lockPath, quarantinedPath);
    } catch {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}

/**
 * Build a LockManager scoped to a job store's own state root, so its locks
 * are visible under that store's root rather than the process-global default.
 * @param {{ _stateRoot: string }} store
 * @param {object} [options] extra LockManager options (e.g. timeoutMs)
 * @returns {LockManager}
 */
function lockManagerForStore(store, options = {}) {
  return new LockManager({ ...options, lockDir: path.join(store._stateRoot, 'locks') });
}

module.exports = {
  LockManager,
  LOCK_SCOPES,
  LOCK_EXIT_CODE,
  DEFAULT_TIMEOUT_MS,
  lockManagerForStore,
};
