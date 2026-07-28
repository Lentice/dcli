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

module.exports = {
  getOwnIdentity,
  generateExecutionToken,
  formatWorkerIdentity,
  parseWorkerIdentity,
  identitiesMatch,
  isProcessAlive,
  PROCESS_START_TIME,
};
