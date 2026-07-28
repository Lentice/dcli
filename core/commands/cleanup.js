const fs = require('fs');
const path = require('path');
const { LockManager, LOCK_SCOPES } = require('../locking');

const TERMINAL = Object.freeze(new Set(['done', 'failed', 'timed_out', 'cancelled', 'interrupted']));

/**
 * Parse a duration string like "30d" or "12h" into milliseconds.
 * Validates format and enforces a minimum of 1 day.
 * @param {string} str
 * @returns {number} milliseconds
 */
function parseDuration(str) {
  if (!str || typeof str !== 'string') {
    const err = new Error('--older-than requires a value like "30d" or "12h"');
    err.exitCode = 2;
    throw err;
  }

  const match = str.match(/^(\d+)([dh])$/);
  if (!match) {
    const err = new Error(`Invalid --older-than format: "${str}". Use e.g. "30d" or "12h"`);
    err.exitCode = 2;
    throw err;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];
  const msPerUnit = unit === 'd' ? 86400000 : 3600000;
  const totalMs = value * msPerUnit;

  // Enforce minimum of 1 day
  if (totalMs < 86400000) {
    const err = new Error(`--older-than "${str}" is below the minimum of 1 day`);
    err.exitCode = 2;
    throw err;
  }

  return totalMs;
}

/**
 * Compute the age of a job in milliseconds based on finished_at, started_at, or created_at.
 * @param {object} status
 * @returns {number} age in ms, or Infinity if no timestamp available
 */
function jobAgeMs(status) {
  const ts = status.finished_at || status.started_at || status.created_at;
  if (!ts) return Infinity;
  return Date.now() - new Date(ts).getTime();
}

async function executeCleanup({ store, olderThan, dryRun, scrubSessionIds }) {
  const lockManager = new LockManager({ lockDir: path.join(store._stateRoot, 'locks'), timeoutMs: 100 });
  const jobsDir = path.join(store._stateRoot, 'jobs');

  const ageThresholdMs = olderThan ? parseDuration(olderThan) : 0;

  const result = {
    dryRun: !!dryRun,
    removed: 0,
    skipped: 0,
    scrubbed: 0,
    errors: [],
  };

  if (!fs.existsSync(jobsDir)) {
    return result;
  }

  const repoDirs = fs.readdirSync(jobsDir, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const repoDir of repoDirs) {
    const repoFull = path.join(jobsDir, repoDir.name);
    const repoKey = repoDir.name;

    const jobDirs = fs.readdirSync(repoFull, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const jobDir of jobDirs) {
      const statusPath = path.join(repoFull, jobDir.name, 'status.json');
      if (!fs.existsSync(statusPath)) continue;

      let status;
      try {
        status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      } catch {
        continue;
      }

      const jobId = status.job_id || jobDir.name;

      // --scrub-session-ids mode: blank backend_session_id on terminal jobs
      if (scrubSessionIds) {
        if (TERMINAL.has(status.state) && status.backend_session_id) {
          if (!dryRun) {
            status.backend_session_id = null;
            const { writeJsonFileAtomic } = require('../fs-text');
            try {
              writeJsonFileAtomic(statusPath, status);
              result.scrubbed++;
            } catch (err) {
              result.errors.push(`Failed to scrub session id for ${repoKey}/${jobId}: ${err.message}`);
            }
          }
        }
        // scrub-session-ids does not delete; continue to next job
        continue;
      }

      // Skip non-terminal jobs
      if (!TERMINAL.has(status.state)) {
        continue;
      }

      // Check age
      if (ageThresholdMs > 0) {
        const age = jobAgeMs(status);
        if (age < ageThresholdMs) {
          continue;
        }
      }

      // Try to acquire per-job lock
      let perJobLock;
      try {
        perJobLock = lockManager.tryAcquire('per-job', jobId, { operation: 'cleanup' });
      } catch {
        perJobLock = null;
      }

      if (!perJobLock) {
        result.skipped++;
        continue;
      }

      // Re-check eligibility after acquiring lock
      let recheckedStatus;
      try {
        recheckedStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      } catch {
        lockManager.release(perJobLock);
        continue;
      }

      if (!TERMINAL.has(recheckedStatus.state)) {
        lockManager.release(perJobLock);
        result.skipped++;
        continue;
      }

      if (ageThresholdMs > 0) {
        const recheckedAge = jobAgeMs(recheckedStatus);
        if (recheckedAge < ageThresholdMs) {
          lockManager.release(perJobLock);
          result.skipped++;
          continue;
        }
      }

      // Check lease
      const leaseLock = lockManager.tryAcquire('job-lease', jobId, { operation: 'cleanup-lease-check' });
      if (!leaseLock) {
        // Lease is held by someone else (e.g. diff/apply)
        lockManager.release(perJobLock);
        result.skipped++;
        continue;
      }
      lockManager.release(leaseLock);

      if (dryRun) {
        lockManager.release(perJobLock);
        result.removed++;
        continue;
      }

      // Remove the job directory
      const jobFullPath = path.join(repoFull, jobDir.name);
      try {
        fs.rmSync(jobFullPath, { recursive: true, force: true });
        result.removed++;
      } catch (err) {
        result.errors.push(`Failed to remove ${repoKey}/${jobId}: ${err.message}`);
      } finally {
        lockManager.release(perJobLock);
      }
    }
  }

  return result;
}

module.exports = { executeCleanup, parseDuration };
