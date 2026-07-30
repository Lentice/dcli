const os = require('os');
const crypto = require('crypto');

const PROCESS_START_TIME = new Date();

/**
 * @returns {{ pid: number, ppid: number, startTime: string, imagePath: string, hostname: string }}
 */
function getOwnIdentity() {
  return {
    pid: process.pid,
    ppid: process.ppid,
    startTime: PROCESS_START_TIME.toISOString(),
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
  return { pid, startTime: parts.slice(1).join(';') };
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

  // Self-pid: identity verified by matching own startTime
  if (identity.pid === process.pid) {
    return identity.startTime === PROCESS_START_TIME.toISOString();
  }

  // Non-self pid: try OS-level startTime verification
  try {
    const startTime = getProcessStartTime(identity.pid);
    if (startTime) return startTime === identity.startTime;
  } catch {}

  // Fall through: can't query OS — accept basic liveness check
  return true;
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
    const match = stat.match(/^\d+\s+\(.+?\)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)/);
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

module.exports = {
  getOwnIdentity,
  generateExecutionToken,
  formatWorkerIdentity,
  parseWorkerIdentity,
  identitiesMatch,
  isProcessAlive,
  isSameProcessAlive,
  getProcessStartTime,
  PROCESS_START_TIME,
};
