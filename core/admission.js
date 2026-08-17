const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LockManager } = require('./locking');
const { TERMINAL } = require('./reducer');
const { isStateRootUnwritableError, toStateRootError } = require('./state-root');

const DEFAULT_GLOBAL_LIMIT = 5;
const DEFAULT_PER_BACKEND_LIMIT = 5;

class AdmissionController {
  constructor({ stateRoot, globalLimit, backendLimits, readJobState }) {
    this._stateRoot = stateRoot;
    this._globalLimit = globalLimit !== undefined ? globalLimit : DEFAULT_GLOBAL_LIMIT;
    this._backendLimits = backendLimits || {};
    this._perBackendLimit = DEFAULT_PER_BACKEND_LIMIT;
    this._slotDir = path.join(stateRoot, 'locks', 'admission');
    this._queueDir = path.join(stateRoot, 'queue');
    this._ownIdentity = this._captureIdentity();
    this._ownToken = this._ownIdentity.startTime + ':' + process.pid;
    this._lockManager = new LockManager({ lockDir: path.join(stateRoot, 'locks'), stateRoot });
    // The dispatcher must not launch a job that is no longer queued; the
    // queue is the only coordination point between cancel and relaunch.
    this._readJobState = readJobState || ((repoKey, jobId) => {
      const { JobStore } = require('./job-store');
      return new JobStore({ stateRoot: this._stateRoot }).readStatus({ repoKey, jobId });
    });
  }

  _captureIdentity() {
    // Process identity, not "now". A per-instance timestamp made two
    // controllers in the same process disown each other's slots, and made
    // every other process's slot look dead to the liveness check.
    // Cheap identity, same trade-off as LockManager: no subprocess on a path
    // every command runs. A stale slot held by a reused pid costs capacity,
    // not correctness, and reconcile reclaims it once the pid is free.
    return require('./process-identity').getDurableOwnIdentity();
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _listSlotFiles() {
    this._ensureDir(this._slotDir);
    return fs.readdirSync(this._slotDir).filter(f => f.endsWith('.json'));
  }

  _readSlotFile(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  _countActiveSlots(backend) {
    const files = this._listSlotFiles();
    let globalActive = 0;
    const backendCounts = {};

    for (const f of files) {
      const meta = this._readSlotFile(path.join(this._slotDir, f));
      if (!meta) continue;
      const alive = this._isSlotAlive(meta);
      if (!alive) continue;
      globalActive++;
      const b = meta.backend || 'unknown';
      backendCounts[b] = (backendCounts[b] || 0) + 1;
    }

    const backendActive = backend ? (backendCounts[backend] || 0) : 0;
    return { globalActive, backendActive, backendCounts, totalFiles: files.length };
  }

  _isSlotAlive(meta) {
    if (!meta || !meta.pid) return false;
    if (meta.pid === this._ownIdentity.pid) {
      if (meta.startTime && meta.startTime !== this._ownIdentity.startTime) return false;
      if (meta.executionToken && meta.executionToken !== this._ownToken) return false;
      return true;
    }
    const { isSameProcessAlive } = require('./process-identity');
    return isSameProcessAlive({ pid: meta.pid, startTime: meta.startTime, startTimeSource: meta.startTimeSource, imagePath: meta.imagePath });
  }

  _generateSlotId() {
    return crypto.randomBytes(16).toString('hex');
  }

  _writeSlotFile(slotId, backend) {
    const filePath = path.join(this._slotDir, `${slotId}.json`);
    const meta = {
      slotId,
      backend,
      pid: this._ownIdentity.pid,
      ppid: this._ownIdentity.ppid,
      startTime: this._ownIdentity.startTime,
      startTimeSource: this._ownIdentity.startTimeSource,
      imagePath: this._ownIdentity.imagePath,
      hostname: this._ownIdentity.hostname,
      executionToken: this._ownToken,
      acquiredAt: new Date().toISOString(),
    };
    fs.writeFileSync(filePath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    return meta;
  }

  _deleteSlotFile(slotId) {
    const filePath = path.join(this._slotDir, `${slotId}.json`);
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }

  acquireSlot(backend) {
    const b = backend || 'unknown';
    let lock = null;
    try {
      lock = this._lockManager.tryAcquire('admission', 'global');
      if (!lock) {
        return {
          acquired: false,
          queued: true,
          reason: 'contention',
          active: this._countActiveSlots(b).globalActive,
          limit: this._globalLimit,
        };
      }

      const { globalActive, backendActive } = this._countActiveSlots(b);

      if (globalActive >= this._globalLimit) {
        return { acquired: false, queued: true, reason: 'global_limit', active: globalActive, limit: this._globalLimit };
      }

      const perBackendLimit = this._backendLimits[b] !== undefined ? this._backendLimits[b] : this._perBackendLimit;
      if (backendActive >= perBackendLimit) {
        return { acquired: false, queued: true, reason: 'backend_limit', backend: b, active: backendActive, limit: perBackendLimit };
      }

      const slotId = this._generateSlotId();
      const meta = this._writeSlotFile(slotId, b);
      return { acquired: true, queued: false, slotId, executionToken: meta.executionToken };
    } catch (err) {
      const stateError = isStateRootUnwritableError(err)
        ? err
        : toStateRootError(this._stateRoot, err);
      if (stateError) {
        return {
          acquired: false,
          queued: false,
          reason: 'state_root_unwritable',
          stateRoot: this._stateRoot,
          error: stateError,
        };
      }
      throw err;
    } finally {
      if (lock) this._lockManager.release(lock);
    }
  }

  releaseSlot(slotId) {
    if (!slotId) return 0;
    this._deleteSlotFile(slotId);
    return this.tryDequeue();
  }

  enqueueJob(backend, jobId, meta) {
    this._ensureDir(this._queueDir);
    const filePath = path.join(this._queueDir, `${jobId}.json`);
    if (fs.existsSync(filePath)) return false;
    const entry = {
      jobId,
      backend: backend || 'unknown',
      enqueuedAt: new Date().toISOString(),
      ...meta,
    };
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2) + '\n', 'utf8');
    return true;
  }

  dequeueJob(jobId) {
    const filePath = path.join(this._queueDir, `${jobId}.json`);
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  _claimQueueEntry(entry) {
    const source = path.join(this._queueDir, entry.fileName);
    const claim = path.join(this._queueDir, `${entry.jobId}.launching-${crypto.randomBytes(8).toString('hex')}.json`);
    try {
      // Leave a bounded launch lease in the record before the atomic rename.
      // A second dispatcher must not mistake a still-starting child for a
      // dead claim and launch the same job twice.
      fs.writeFileSync(source, JSON.stringify({
        ...entry,
        launch_started_at: Date.now(),
      }, null, 2) + '\n', 'utf8');
      fs.renameSync(source, claim);
      return claim;
    } catch {
      return null;
    }
  }

  _restoreQueueClaim(claimPath, entry) {
    if (!claimPath || !fs.existsSync(claimPath)) return;
    const target = path.join(this._queueDir, `${entry.jobId}.json`);
    try {
      if (!fs.existsSync(target)) fs.renameSync(claimPath, target);
      else fs.unlinkSync(claimPath);
    } catch {}
  }

  _reconcileQueueClaims() {
    for (const file of fs.readdirSync(this._queueDir).filter(f => f.includes('.launching-') && f.endsWith('.json'))) {
      const claim = path.join(this._queueDir, file);
      try {
        const entry = JSON.parse(fs.readFileSync(claim, 'utf8'));
        if (entry.launch_started_at && Date.now() - entry.launch_started_at < 30000) continue;
        const target = path.join(this._queueDir, `${entry.jobId}.json`);
        if (fs.existsSync(target)) fs.unlinkSync(claim);
        else fs.renameSync(claim, target);
      } catch {}
    }
  }

  tryDequeue() {
    this._ensureDir(this._queueDir);
    this._reconcileQueueClaims();
    const files = fs.readdirSync(this._queueDir).filter(f => f.endsWith('.json') && !f.includes('.launching-'));
    if (files.length === 0) return 0;

    const queueEntries = [];
    for (const f of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this._queueDir, f), 'utf8'));
        queueEntries.push({ ...meta, fileName: f });
      } catch {}
    }

    queueEntries.sort((a, b) => (a.enqueuedAt || '').localeCompare(b.enqueuedAt || ''));

    let dequeued = 0;
    for (const entry of queueEntries) {
      // A job that is no longer queued (cancelled, failed, ...) must never be
      // launched from the queue: the queue is the only coordination point
      // between cancel and the relaunch path. Terminal states are decided by
      // the reducer; the queue only skips its entries.
      let jobState = null;
      try {
        jobState = this._readJobState(entry.repoKey, entry.jobId);
      } catch {
        jobState = null;
      }
      if (jobState && TERMINAL.has(jobState.state)) continue;

      // A queued worker must acquire the slot in its own process. A slot file
      // owned by this dispatcher cannot be transferred safely to a detached
      // child: the parent may exit and reconciliation would reclaim it.
      if (typeof this._spawnWorker === 'function') {
        const counts = this._countActiveSlots(entry.backend);
        const backendLimit = this._backendLimits[entry.backend] !== undefined
          ? this._backendLimits[entry.backend] : this._perBackendLimit;
        if (counts.globalActive >= this._globalLimit || counts.backendActive >= backendLimit) break;
        const claimPath = this._claimQueueEntry(entry);
        if (!claimPath) continue;
        try {
          this._spawnWorker({ ...entry, queued: true, queueClaimPath: claimPath });
          dequeued++;
        } catch {
          this._restoreQueueClaim(claimPath, entry);
        }
        continue;
      }

      const result = this.acquireSlot(entry.backend);
      if (result.acquired) {
        this.dequeueJob(entry.jobId);
        dequeued++;
      } else {
        break;
      }
    }

    return dequeued;
  }

  setSpawnWorker(fn) {
    this._spawnWorker = fn;
  }

  reconcile() {
    const files = this._listSlotFiles();
    let reclaimed = 0;

    for (const f of files) {
      const meta = this._readSlotFile(path.join(this._slotDir, f));
      if (!meta) {
        try { fs.unlinkSync(path.join(this._slotDir, f)); } catch {}
        reclaimed++;
        continue;
      }
      if (!this._isSlotAlive(meta)) {
        try { fs.unlinkSync(path.join(this._slotDir, f)); } catch {}
        reclaimed++;
      }
    }

    // Nudge the queue: a reconciliation that reclaimed slots freed capacity,
    // and the only other launch trigger is releaseSlot. reconcile() runs at
    // CLI startup and worker startup — both safe places to dispatch.
    // tryDequeue already respects capacity, the launch lease and job state.
    this.tryDequeue();

    return reclaimed;
  }

  getUtilization() {
    const { globalActive, backendCounts } = this._countActiveSlots(null);
    const backends = {};
    const allBackendNames = new Set([
      ...Object.keys(this._backendLimits),
      ...Object.keys(backendCounts),
    ]);
    for (const b of allBackendNames) {
      backends[b] = {
        active: backendCounts[b] || 0,
        limit: this._backendLimits[b] !== undefined ? this._backendLimits[b] : this._perBackendLimit,
      };
    }
    return {
      global: { active: globalActive, limit: this._globalLimit },
      backends,
    };
  }
}

module.exports = { AdmissionController };
