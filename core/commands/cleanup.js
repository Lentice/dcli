const fs = require('fs');
const path = require('path');
const { LOCK_SCOPES, lockManagerForStore } = require('../locking');
const { computeRepoKey } = require('../repo-key');
const { getMainRepoRoot, removeWorktreeChecked } = require('../worktree');

const { TERMINAL } = require('../reducer');

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

function pathAgeMs(target) {
  try {
    return Date.now() - fs.statSync(target).mtimeMs;
  } catch {
    return Infinity;
  }
}

function worktreeBytes(target) {
  if (!fs.existsSync(target)) return 0;
  let total = 0;
  const pending = [target];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        pending.push(path.join(current, entry.name));
      }
    } else {
      total += stat.size;
    }
  }
  return total;
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function validateWorktreePath(worktreePath, stateRoot) {
  const worktreesRoot = path.join(stateRoot, 'worktrees');
  if (!isWithin(worktreesRoot, worktreePath)) {
    const err = new Error(`Worktree path escapes state root: ${worktreePath}`);
    err.exitCode = 23;
    throw err;
  }

  if (fs.existsSync(worktreePath)) {
    let realRoot;
    let realTarget;
    try {
      realRoot = fs.realpathSync.native(worktreesRoot);
      realTarget = fs.realpathSync.native(worktreePath);
    } catch (cause) {
      const err = new Error(`Could not inspect worktree path ${worktreePath}: ${cause.message}`);
      err.exitCode = 23;
      throw err;
    }
    if (!isWithin(realRoot, realTarget)) {
      const err = new Error(`Worktree path escapes state root: ${worktreePath}`);
      err.exitCode = 23;
      throw err;
    }
  }
  return path.resolve(worktreePath);
}

function addWorktree(result, worktreePath, bytes, jobId, orphan) {
  result.worktrees.push({ path: worktreePath, bytes, jobId: jobId || null, orphan: !!orphan });
}

function skip(result, name, reason, worktreePath) {
  result.skipped++;
  result.skippedItems.push({ name, reason, path: worktreePath || null });
}

function acquireArtifactLocks(lockManager, { jobId, repoKey, name, result, worktreePath }) {
  let perJobLock;
  try {
    perJobLock = lockManager.tryAcquire(LOCK_SCOPES.PER_JOB, jobId, { operation: 'cleanup' });
  } catch {
    perJobLock = null;
  }
  if (!perJobLock) {
    skip(result, name, 'job lock held', worktreePath);
    return null;
  }

  const leaseLock = lockManager.tryAcquire(LOCK_SCOPES.JOB_LEASE, jobId, { operation: 'cleanup-lease-check' });
  if (!leaseLock) {
    lockManager.release(perJobLock);
    skip(result, name, 'artifact lease held by a reader', worktreePath);
    return null;
  }

  const repoLock = lockManager.tryAcquire(LOCK_SCOPES.APPLY, repoKey, { operation: 'cleanup', jobId });
  if (!repoLock) {
    lockManager.release(leaseLock);
    lockManager.release(perJobLock);
    skip(result, name, 'repository lock held', worktreePath);
    return null;
  }

  return { perJobLock, leaseLock, repoLock };
}

function releaseArtifactLocks(lockManager, locks) {
  if (!locks) return;
  lockManager.release(locks.repoLock);
  lockManager.release(locks.leaseLock);
  lockManager.release(locks.perJobLock);
}

function collectJobRecords(jobsDir) {
  const records = [];
  const knownJobIds = new Set();
  if (!fs.existsSync(jobsDir)) return { records, knownJobIds };

  for (const repoDir of fs.readdirSync(jobsDir, { withFileTypes: true })) {
    if (!repoDir.isDirectory()) continue;
    const repoFull = path.join(jobsDir, repoDir.name);
    for (const jobDir of fs.readdirSync(repoFull, { withFileTypes: true })) {
      if (!jobDir.isDirectory()) continue;
      knownJobIds.add(jobDir.name);
      const jobFullPath = path.join(repoFull, jobDir.name);
      const statusPath = path.join(jobFullPath, 'status.json');
      if (!fs.existsSync(statusPath)) continue;
      try {
        records.push({
          repoKey: repoDir.name,
          jobId: jobDir.name,
          jobFullPath,
          statusPath,
          status: JSON.parse(fs.readFileSync(statusPath, 'utf8')),
        });
      } catch {
        // Corrupt records are left for the state/corruption diagnostics path.
      }
    }
  }
  return { records, knownJobIds };
}

function eligible(status, ageThresholdMs) {
  return TERMINAL.has(status.state) &&
    (ageThresholdMs === 0 || jobAgeMs(status) >= ageThresholdMs);
}

function worktreeInfo(status, stateRoot) {
  const recordedPath = status.worktree && status.worktree.path;
  if (!recordedPath) return null;
  const worktreePath = validateWorktreePath(recordedPath, stateRoot);
  return { path: worktreePath, bytes: worktreeBytes(worktreePath) };
}

async function executeCleanup({ store, olderThan, dryRun, scrubSessionIds }) {
  const lockManager = lockManagerForStore(store, { timeoutMs: 100 });
  const jobsDir = path.join(store._stateRoot, 'jobs');
  const worktreesDir = path.join(store._stateRoot, 'worktrees');
  const ageThresholdMs = olderThan ? parseDuration(olderThan) : 0;
  const result = {
    dryRun: !!dryRun,
    removed: 0,
    skipped: 0,
    scrubbed: 0,
    errors: [],
    worktrees: [],
    skippedItems: [],
  };

  const { records, knownJobIds } = collectJobRecords(jobsDir);

  for (const record of records) {
    const { repoKey, jobId, jobFullPath, statusPath } = record;
    const name = `${repoKey}/${jobId}`;

    // --scrub-session-ids mode: blank backend_session_id on terminal jobs
    if (scrubSessionIds) {
      if (TERMINAL.has(record.status.state) && record.status.backend_session_id && !dryRun) {
        record.status.backend_session_id = null;
        try {
          store._atomicWriteJsonWithRetry(statusPath, record.status);
          result.scrubbed++;
        } catch (err) {
          result.errors.push(`Failed to scrub session id for ${name}: ${err.message}`);
        }
      }
      continue;
    }

    if (!eligible(record.status, ageThresholdMs)) continue;

    let info;
    try {
      info = worktreeInfo(record.status, store._stateRoot);
    } catch (err) {
      result.errors.push(`Failed to inspect ${name}: ${err.message}`);
      continue;
    }

    const locks = acquireArtifactLocks(lockManager, {
      jobId, repoKey, name, result, worktreePath: info && info.path,
    });
    if (!locks) continue;

    try {
      let recheckedStatus;
      try {
        recheckedStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      } catch (err) {
        result.errors.push(`Failed to recheck ${name}: ${err.message}`);
        continue;
      }
      if (!eligible(recheckedStatus, ageThresholdMs)) {
        skip(result, name, 'job is no longer eligible', info && info.path);
        continue;
      }

      info = worktreeInfo(recheckedStatus, store._stateRoot);
      if (info) {
        if (!recheckedStatus.repo_root) {
          throw new Error(`Job ${jobId} has no repo_root for worktree cleanup`);
        }
        if (!dryRun) removeWorktreeChecked(recheckedStatus.repo_root, info.path);
      }

      if (dryRun) {
        if (info) addWorktree(result, info.path, info.bytes, jobId, false);
        result.removed++;
        continue;
      }

      fs.rmSync(jobFullPath, { recursive: true, force: true });
      if (fs.existsSync(jobFullPath)) throw new Error(`Job directory still exists after removal: ${jobFullPath}`);
      if (info) addWorktree(result, info.path, info.bytes, jobId, false);
      result.removed++;
    } catch (err) {
      result.errors.push(`Failed to remove ${name}: ${err.message}`);
    } finally {
      releaseArtifactLocks(lockManager, locks);
    }
  }

  if (scrubSessionIds || !fs.existsSync(worktreesDir)) return result;

  for (const entry of fs.readdirSync(worktreesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || knownJobIds.has(entry.name)) continue;
    const worktreePath = path.join(worktreesDir, entry.name);
    if (ageThresholdMs > 0 && pathAgeMs(worktreePath) < ageThresholdMs) continue;

    let repoRoot;
    try {
      repoRoot = getMainRepoRoot(worktreePath);
    } catch (err) {
      result.errors.push(`Failed to inspect orphan worktree ${worktreePath}: ${err.message}`);
      continue;
    }
    const repoKey = computeRepoKey(repoRoot);
    const locks = acquireArtifactLocks(lockManager, {
      jobId: entry.name, repoKey, name: `orphan/${entry.name}`, result, worktreePath,
    });
    if (!locks) continue;

    try {
      const bytes = worktreeBytes(worktreePath);
      if (!dryRun) removeWorktreeChecked(repoRoot, worktreePath);
      addWorktree(result, worktreePath, bytes, entry.name, true);
    } catch (err) {
      result.errors.push(`Failed to remove orphan worktree ${worktreePath}: ${err.message}`);
    } finally {
      releaseArtifactLocks(lockManager, locks);
    }
  }

  return result;
}

module.exports = { executeCleanup, parseDuration };
