const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const DEFAULT_GLOBAL_LIMIT = 5;
const DEFAULT_PER_BACKEND_LIMIT = 5;

class AdmissionController {
  constructor({ stateRoot, globalLimit, backendLimits }) {
    this._stateRoot = stateRoot;
    this._globalLimit = globalLimit !== undefined ? globalLimit : DEFAULT_GLOBAL_LIMIT;
    this._backendLimits = backendLimits || {};
    this._perBackendLimit = DEFAULT_PER_BACKEND_LIMIT;
    this._slotDir = path.join(stateRoot, 'locks', 'admission');
    this._queueDir = path.join(stateRoot, 'queue');
    this._ownIdentity = this._captureIdentity();
  }

  _captureIdentity() {
    return {
      pid: process.pid,
      ppid: process.ppid,
      startTime: new Date().toISOString(),
      hostname: os.hostname(),
    };
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
      const alive = this._isPidAlive(meta);
      if (!alive) continue;
      globalActive++;
      const b = meta.backend || 'unknown';
      backendCounts[b] = (backendCounts[b] || 0) + 1;
    }

    const backendActive = backend ? (backendCounts[backend] || 0) : 0;
    return { globalActive, backendActive, backendCounts, totalFiles: files.length };
  }

  _isPidAlive(meta) {
    if (!meta || !meta.pid) return false;
    try {
      process.kill(meta.pid, 0);
      return true;
    } catch (err) {
      if (err.code === 'EPERM') return true;
      return false;
    }
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
      startTime: this._ownIdentity.startTime,
      hostname: this._ownIdentity.hostname,
      executionToken: this._ownIdentity.startTime + ':' + process.pid,
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
    const { globalActive, backendActive, backendCounts } = this._countActiveSlots(b);

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
  }

  releaseSlot(slotId) {
    if (!slotId) return 0;
    this._deleteSlotFile(slotId);
    return this.tryDequeue();
  }

  enqueueJob(backend, jobId) {
    this._ensureDir(this._queueDir);
    const filePath = path.join(this._queueDir, `${jobId}.json`);
    if (fs.existsSync(filePath)) return false;
    const meta = {
      jobId,
      backend: backend || 'unknown',
      enqueuedAt: new Date().toISOString(),
    };
    fs.writeFileSync(filePath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
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

  tryDequeue() {
    this._ensureDir(this._queueDir);
    const files = fs.readdirSync(this._queueDir).filter(f => f.endsWith('.json'));
    if (files.length === 0) return 0;

    const queueEntries = [];
    for (const f of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this._queueDir, f), 'utf8'));
        queueEntries.push(meta);
      } catch {}
    }

    queueEntries.sort((a, b) => (a.enqueuedAt || '').localeCompare(b.enqueuedAt || ''));

    let dequeued = 0;
    for (const entry of queueEntries) {
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
      if (!this._isPidAlive(meta)) {
        try { fs.unlinkSync(path.join(this._slotDir, f)); } catch {}
        reclaimed++;
      }
    }

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
