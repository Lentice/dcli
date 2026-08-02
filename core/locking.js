const fs = require('fs');
const path = require('path');
const { getOwnIdentity, generateExecutionToken, isProcessAlive, isSameProcessAlive } = require('./process-identity');

// Only scopes with a real caller. Lock names are persisted as filenames, so a
// scope is a contract the moment something takes it — add one when a caller
// exists, never speculatively.
const LOCK_SCOPES = Object.freeze({
  APPLY: 'apply',
  JOB_LEASE: 'job-lease',
  PER_JOB: 'per-job',
});

const LOCK_EXIT_CODE = 17;

const DEFAULT_TIMEOUT_MS = 10000;

// How long an unparseable lock file is given before it is treated as junk.
const UNPARSEABLE_LOCK_GRACE_MS = 1000;

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
    // Deliberately the CHEAP identity: no OS creation-time lookup. A lock is
    // taken on every journal write, and a subprocess there is not affordable —
    // it timed a fixture out under a loaded suite. The cost of not having a
    // verifiable creation time is bounded and safe-direction: a reused pid
    // makes a dead owner's lock look live, so acquisition times out with exit
    // 17 instead of two holders sharing a lock. Readers know the timestamp is
    // Node-sourced (startTimeSource) and skip the comparison rather than
    // mistaking it for a mismatch.
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

  _writeMetadata(lockPath, extra, identity) {
    const id = identity || this._ownIdentity;
    const metadata = {
      schema_version: 1,
      pid: id.pid,
      ppid: id.ppid,
      startTime: id.startTime,
      startTimeSource: id.startTimeSource,
      imagePath: id.imagePath,
      hostname: id.hostname,
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
      const lock = this._heldLocks.get(lockKey);
      lock.depth = (lock.depth || 1) + 1;
      return lock;
    }

    const lockPath = this._lockPath(scope, key);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    const deadline = Date.now() + this._timeoutMs;
    let lastError = null;

    while (Date.now() < deadline) {
      try {
        return this._createLockFile(scope, key, lockPath, extra);
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
   * Create the lock file exclusively and register the handle. Throws EEXIST
   * when the lock is already held — the single place both acquire() and
   * tryAcquire() go through, so their handle shape cannot drift apart.
   *
   * @returns {object} lock handle
   */
  _createLockFile(scope, key, lockPath, extra) {
    // The lock file must never be observable empty. `openSync('wx')` followed
    // by a write leaves a zero-byte file at the real path for as long as the
    // write takes, and an unparseable lock file reads as stale — so a
    // contender could quarantine a lock that was being created and take the
    // same logical lock. Writing a complete temp file and hard-linking it into
    // place makes the lock appear fully formed or not at all; link() is the
    // atomic create-if-absent primitive (rename would overwrite, which is
    // exactly the exclusivity we need to keep).
    const identity = this._ownIdentity;
    const tempPath = `${lockPath}.${process.pid}.${this._ownToken.slice(0, 8)}.tmp`;
    this._writeMetadata(tempPath, extra, identity);
    try {
      fs.linkSync(tempPath, lockPath);
    } catch (linkErr) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw linkErr;
    }
    try { fs.unlinkSync(tempPath); } catch {}

    const lock = {
      scope,
      key,
      lockPath,
      released: false,
      depth: 1,
      acquiredAt: new Date().toISOString(),
      executionToken: this._ownToken,
    };
    this._heldLocks.set(`${scope}:${key}`, lock);
    return lock;
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
      const lock = this._heldLocks.get(lockKey);
      lock.depth = (lock.depth || 1) + 1;
      return lock;
    }

    const lockPath = this._lockPath(scope, key);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    try {
      return this._createLockFile(scope, key, lockPath, extra);
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
    if (lock.depth > 1) {
      lock.depth -= 1;
      return;
    }
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
        // Unparseable, but not necessarily abandoned. Some other writer may be
        // mid-creation; quarantining instantly is how two holders end up
        // sharing a lock. Only a file that has been unreadable for a while is
        // genuinely junk.
        let ageMs = Infinity;
        try { ageMs = Date.now() - fs.statSync(lockPath).mtimeMs; } catch {}
        if (ageMs < UNPARSEABLE_LOCK_GRACE_MS) return false;
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

      const alive = isSameProcessAlive({ pid: meta.pid, startTime: meta.startTime, startTimeSource: meta.startTimeSource, imagePath: meta.imagePath });
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
