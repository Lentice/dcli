const { LOCK_SCOPES, lockManagerForStore } = require('../locking');
const { getDiff } = require('../worktree');

const { loadJobOrThrow } = require('./index');

function executeDiff({ store, repoKey, jobId, stat, nameOnly }) {
  // Shared loader: absence is the job directory's, and an unreadable record is
  // exit 17, never a claim that the job does not exist.
  const { status } = loadJobOrThrow({ store, repoKey, jobId, regenerate: false });

  const worktreeInfo = status.worktree;
  if (!worktreeInfo) {
    const err = new Error(`Job ${jobId} has no worktree info. It must be an implement-mode job.`);
    err.exitCode = 11;
    throw err;
  }

  if (worktreeInfo.finalize_error) {
    const err = new Error(`Job ${jobId} has a snapshot finalization error (finalize_error: ${worktreeInfo.finalize_error}). Cannot diff.`);
    err.exitCode = 11;
    throw err;
  }

  if (!worktreeInfo.result_commit) {
    const err = new Error(`Job ${jobId} has no result commit. It must be an implement-mode job.`);
    err.exitCode = 11;
    throw err;
  }

  if (!worktreeInfo.base_commit) {
    const err = new Error(`Job ${jobId} has no base commit recorded.`);
    err.exitCode = 11;
    throw err;
  }

  if (stat && nameOnly) {
    const err = new Error('--stat and --name-only are mutually exclusive');
    err.exitCode = 2;
    throw err;
  }

  const locks = lockManagerForStore(store);

  const leaseLock = locks.acquire(LOCK_SCOPES.JOB_LEASE, jobId, { operation: 'diff' });
  const applyLock = locks.acquire(LOCK_SCOPES.APPLY, repoKey, { operation: 'diff' });
  try {
    let format = null;
    if (stat) format = 'stat';
    else if (nameOnly) format = 'name-only';

    const repoRoot = status.repo_root;
    if (!repoRoot) {
      const err = new Error(`Job ${jobId} has no repo_root`);
      err.exitCode = 11;
      throw err;
    }

    const diffOutput = getDiff(repoRoot, worktreeInfo.base_commit, worktreeInfo.result_commit, format);

    return { text: diffOutput, exitCode: 0 };
  } finally {
    locks.release(applyLock);
    locks.release(leaseLock);
  }
}

module.exports = { executeDiff };
