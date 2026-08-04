const os = require('os');
const crypto = require('crypto');

const PROCESS_START_TIME = new Date();

// Marks a recorded start time as OS-reported, and therefore comparable with a
// later OS query. Part of the persisted worker_identity string.
const OS_START_TIME_TAG = 'os:';

/**
 * @returns {{ pid: number, ppid: number, startTime: string, imagePath: string, hostname: string }}
 */
function getOwnIdentity() {
  return {
    pid: process.pid,
    ppid: process.ppid,
    startTime: PROCESS_START_TIME.toISOString(),
    // PROCESS_START_TIME is when THIS MODULE loaded, not when the OS started
    // the process, so it is not comparable with an OS-reported start time.
    // Recording where it came from is what stops a reader from "verifying"
    // a live process against a value that can never match and concluding it
    // is dead — which reclaimed live admission slots and quarantined live
    // locks. See isSameProcessAlive.
    startTimeSource: 'node',
    imagePath: process.execPath,
    hostname: os.hostname(),
  };
}

/**
 * @returns {string}
 */
function generateExecutionToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * @param {number} pid
 * @param {string} startTime
 * @returns {string}
 */
function formatWorkerIdentity(pid, startTime) {
  return `${pid};${startTime}`;
}

/**
 * @param {string|null|undefined} identity
 * @returns {{ pid: number, startTime: string }|null}
 */
function parseWorkerIdentity(identity) {
  if (!identity || typeof identity !== 'string') return null;
  const parts = identity.split(';');
  if (parts.length < 2) return null;
  const pid = parseInt(parts[0], 10);
  if (isNaN(pid) || pid <= 0) return null;
  const rest = parts.slice(1).join(';');
  // The start time may carry a provenance tag ("os:<iso>"). Without knowing
  // where the recorded time came from, a reader cannot tell a genuine mismatch
  // from an incomparable one — untagged values predate the tag and are Node's
  // own clock. Kept as a prefix so the existing "<pid>;<startTime>" shape,
  // which is persisted in status.json, still parses.
  const tagged = rest.startsWith(OS_START_TIME_TAG);
  return {
    pid,
    startTime: tagged ? rest.slice(OS_START_TIME_TAG.length) : rest,
    startTimeSource: tagged ? 'os' : 'node',
  };
}

/**
 * @param {{ pid: number, startTime: string }|null} a
 * @param {{ pid: number, startTime: string }|null} b
 * @returns {boolean}
 */
function identitiesMatch(a, b) {
  if (!a || !b) return false;
  return a.pid === b.pid && a.startTime === b.startTime;
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  if (pid === process.pid) return true;
  if (typeof pid !== 'number' || pid <= 0 || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true;
    return false;
  }
}

/**
 * For non-self pids: verify basic liveness AND try OS-level identity match.
 * Falls back to bare process.kill(pid, 0) when OS querying is unavailable.
 *
 * @param {{ pid: number, startTime: string, imagePath?: string }} identity
 * @returns {boolean}
 */
function isSameProcessAlive(identity) {
  if (!identity || typeof identity.pid !== 'number' || identity.pid <= 0) return false;
  if (!isProcessAlive(identity.pid)) return false;

  // Self-pid: identity verified by matching own startTime — against the same
  // clock it was recorded from, or the check rejects our own process.
  if (identity.pid === process.pid) {
    if (identity.startTimeSource === 'os') {
      const own = getProcessStartTime(process.pid);
      return own ? own === identity.startTime : true;
    }
    return identity.startTime === PROCESS_START_TIME.toISOString();
  }

  // Non-self pid: OS-level startTime verification, but ONLY against a
  // recorded start time that came from the OS too. Comparing an OS start time
  // with a Node-side timestamp always mismatches, which reported every live
  // foreign process as dead.
  if (identity.startTimeSource === 'os') {
    try {
      const cached = processStartTimeCache.get(identity.pid);
      const startTime = cached && Date.now() - cached.checkedAt < PROCESS_START_CACHE_MS
        ? cached.startTime
        : getAndCacheProcessStartTime(identity.pid);
      if (startTime) return startTime === identity.startTime;
    } catch {}
  }

  // Fall through: can't query OS — accept basic liveness check
  return true;
}

const PROCESS_START_CACHE_MS = 200;
const processStartTimeCache = new Map();

function getAndCacheProcessStartTime(pid) {
  const startTime = getProcessStartTime(pid);
  processStartTimeCache.set(pid, { startTime, checkedAt: Date.now() });
  return startTime;
}

/**
 * Get process start time from the OS. Returns ISO string or null.
 *
 * @param {number} pid
 * @returns {string|null}
 */
function getProcessStartTime(pid) {
  const { execSync } = require('node:child_process');
  try {
    if (process.platform === 'win32') {
      const result = execSync(
        `powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString('o')"`,
        { encoding: 'utf8', timeout: 3000, windowsHide: true }
      );
      const line = result.trim();
      return line || null;
    }
    const stat = require('fs').readFileSync(`/proc/${pid}/stat`, 'utf8');
    // starttime is field 22. Fields 1 and 2 are pid and (comm) — comm can
    // contain spaces, hence the non-greedy paren match — so 19 fields (3..21)
    // are skipped before it. The previous expression skipped 15 and captured
    // field 18, `priority`: the same value for nearly every process, which
    // made "creation time" identical across unrelated pids and silently
    // removed the PID-reuse protection it exists to provide.
    const match = stat.match(/^\d+\s+\(.*\)\s+(?:\S+\s+){19}(\d+)/);
    if (match) {
      const bootTime = parseInt(require('fs').readFileSync('/proc/stat', 'utf8').match(/btime\s+(\d+)/)[1], 10);
      const startTicks = parseInt(match[1], 10);
      const hz = 100;
      const epochMs = (bootTime + startTicks / hz) * 1000;
      return new Date(epochMs).toISOString();
    }
  } catch {}
  return null;
}

/** @type {{ pid:number, ppid:number, startTime:string, startTimeSource:string, imagePath:string, hostname:string }|null} */
let durableIdentityCache = null;

/**
 * Own identity with an OS-reported creation time when one can be obtained, so
 * a reader can tell this process from a later one that reused its pid.
 *
 * Resolving it costs a subprocess, so it is deliberately NOT part of
 * getOwnIdentity(). Only the attempt-owner identity uses it — once, when an
 * attempt starts, alongside launching a backend CLI. Locks and admission slots
 * deliberately do NOT: they are written on every journal append, where a
 * subprocess is not affordable (it timed a fixture out under a loaded suite),
 * and their failure mode under pid reuse is bounded — a stale lock reads as
 * live and acquisition times out, rather than two holders sharing it.
 *
 * @returns {{ pid:number, ppid:number, startTime:string, startTimeSource:string, imagePath:string, hostname:string }}
 */
function getDurableOwnIdentity() {
  if (durableIdentityCache) return durableIdentityCache;
  const base = getOwnIdentity();
  const osStartTime = getProcessStartTime(process.pid);
  durableIdentityCache = osStartTime
    ? { ...base, startTime: osStartTime, startTimeSource: 'os' }
    : base;
  return durableIdentityCache;
}

/**
 * Journal detail fields naming the process that owns the running attempt.
 * Every path that writes a `running` transition uses this, so no owner can
 * ship without a persisted identity.
 *
 * @returns {{ worker_pid: number, worker_identity: string }}
 */
function workerIdentityDetail({ durable = true, pid = process.pid } = {}) {
  const foreignStartTime = pid === process.pid ? null : getProcessStartTime(pid);
  const id = pid === process.pid
    ? getOwnIdentity()
    : {
      pid,
      ppid: 0,
      startTime: foreignStartTime || new Date().toISOString(),
      startTimeSource: foreignStartTime ? 'os' : 'node',
      imagePath: process.execPath,
      hostname: os.hostname(),
    };
  // Identity is pid + creation time, not a bare pid: a reused pid otherwise
  // answers "the worker is alive" for an unrelated process and the abandoned
  // job never reaches a terminal state. Only the OS knows the real creation
  // time, and querying it costs a subprocess — affordable here because this
  // runs once when an attempt starts, never on a read path. Best-effort: if
  // the query fails we record Node's clock, tagged as such, and readers fall
  // back to bare liveness rather than comparing incomparable values.
  const durableIdentity = pid === process.pid && durable ? getDurableOwnIdentity() : id;
  const startTime = durableIdentity.startTimeSource === 'os'
    ? OS_START_TIME_TAG + durableIdentity.startTime
    : id.startTime;
  return {
    worker_pid: id.pid,
    worker_identity: formatWorkerIdentity(id.pid, startTime),
  };
}

module.exports = {
  getOwnIdentity,
  getDurableOwnIdentity,
  workerIdentityDetail,
  generateExecutionToken,
  formatWorkerIdentity,
  parseWorkerIdentity,
  identitiesMatch,
  isProcessAlive,
  isSameProcessAlive,
  PROCESS_START_TIME,
};
