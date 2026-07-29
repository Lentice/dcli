const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { LockManager, LOCK_SCOPES } = require('../locking');
const {
  getHeadCommit,
  getStatusPorcelain,
  getUntrackedFilesFromStatus,
  hasResidualGitState,
  clearResidualGitState,
  cherryPickCommits,
  createApplyCommit,
  getCommitCount,
  isGitRepo,
  hasUnresolvedConflicts,
  isNestedRepo,
} = require('../worktree');

function executeApply({ store, repoKey, jobId, resetAuthor, message, allowUntracked }) {
  let status;
  try {
    status = store.readStatus({ repoKey, jobId });
  } catch (readErr) {
    const e = new Error(`Job not found: ${jobId}`);
    e.exitCode = 3; throw e;
  }

  const wi = status.worktree;
  if (!wi) {
    const e = new Error(`Job ${jobId} has no worktree info. Must be an implement-mode job.`);
    e.exitCode = 11; throw e;
  }
  if (wi.finalize_error) {
    const e = new Error(`Job ${jobId} snapshot finalization failed. Cannot apply.`);
    e.exitCode = 11; throw e;
  }
  if (!wi.result_commit) {
    const e = new Error(`Job ${jobId} has no result commit. Must be an implement-mode job.`);
    e.exitCode = 11; throw e;
  }

  const repoRoot = status.repo_root;
  if (!repoRoot) { const e = new Error(`Job ${jobId} has no repo_root`); e.exitCode = 11; throw e; }

  const baseCommit = wi.base_commit;
  const resultCommit = wi.result_commit;
  const commitCount = getCommitCount(repoRoot, baseCommit, resultCommit);
  const isMulti = commitCount > 1;

  if (isMulti && (resetAuthor || message)) {
    const e = new Error('--reset-author/--message not supported for multi-commit series');
    e.exitCode = 2; throw e;
  }

  if (!isGitRepo(repoRoot)) { const e = new Error(`Not a git repo: ${repoRoot}`); e.exitCode = 23; throw e; }
  if (hasUnresolvedConflicts(repoRoot)) { const e = new Error('Unresolved conflicts'); e.exitCode = 2; throw e; }
  if (isNestedRepo(repoRoot)) { const e = new Error('Nested repository'); e.exitCode = 2; throw e; }
  if (hasResidualGitState(repoRoot)) { const e = new Error('In-progress am/rebase/cherry-pick'); e.exitCode = 2; throw e; }

  const preStatusText = getStatusPorcelain(repoRoot);
  const preUntracked = getUntrackedFilesFromStatus(preStatusText);
  const preTracked = _trackedChanges(preStatusText);

  if (preTracked.length > 0) {
    const e = new Error('Working tree has tracked changes. Commit or stash first.');
    e.exitCode = 2; throw e;
  }

  if (preUntracked.length > 0 && !allowUntracked) {
    const e = new Error(
      `Working tree has ${preUntracked.length} untracked file(s). ` +
      `Commit, stash, or remove them first, or pass --allow-untracked to proceed.`
    );
    e.exitCode = 2; throw e;
  }

  const locks = new LockManager();
  const applyLock = locks.acquire(LOCK_SCOPES.APPLY, repoKey, { operation: 'apply', jobId });

  try {
    const preHead = getHeadCommit(repoRoot);
    const preStatusTextFull = getStatusPorcelain(repoRoot);

    let landed;
    try {
      cherryPickCommits(repoRoot, baseCommit, resultCommit);
    } catch (cherryErr) {
      _rollbackOrReport(repoRoot, preHead, preStatusTextFull, preUntracked, cherryErr);
      throw cherryErr;
    }

    try {
      landed = createApplyCommit(repoRoot, message);
    } catch (commitErr) {
      _rollbackOrReport(repoRoot, preHead, preStatusTextFull, preUntracked, commitErr);
      throw commitErr;
    }

    if (hasResidualGitState(repoRoot)) {
      clearResidualGitState(repoRoot);
      if (hasResidualGitState(repoRoot)) {
        const e = new Error('Could not clear residual git state after apply');
        e.exitCode = 25; throw e;
      }
    }

    return { exitCode: 0, landedCommit: landed, preHead };
  } finally {
    locks.release(applyLock);
  }
}

function _rollbackOrReport(repoRoot, preHead, preStatusText, preUntracked, originalError) {
  const postStatusText = getStatusPorcelain(repoRoot);
  const postTracked = _trackedChanges(postStatusText);
  const preTrackedLines = _trackedChanges(preStatusText);

  const newModifications = postTracked.filter(l => !preTrackedLines.includes(l));
  if (newModifications.length > 0) {
    const e = new Error(
      `Apply failed and ${newModifications.length} unexpected tracked modification(s) appeared. ` +
      `Skipping reset to preserve changes. Manual inspection required.\n` +
      `Original: ${originalError.message}`
    );
    e.exitCode = 25;
    throw e;
  }

  _hardReset(repoRoot, preHead, preUntracked);

  if (hasResidualGitState(repoRoot)) {
    clearResidualGitState(repoRoot);
    if (hasResidualGitState(repoRoot)) {
      const e = new Error('Apply failed, repo restored, but residual git state could not be cleared');
      e.exitCode = 25; throw e;
    }
  }
}

function _hardReset(repoRoot, preHead, preUntracked) {
  spawnSync('git', ['reset', '--hard', preHead], { cwd: repoRoot, windowsHide: true, timeout: 30000 });
  const postStatus = getStatusPorcelain(repoRoot);
  const postUntracked = getUntrackedFilesFromStatus(postStatus);
  const newUntracked = postUntracked.filter(f => !preUntracked.includes(f));
  for (const file of newUntracked) {
    try { fs.unlinkSync(path.resolve(repoRoot, file)); } catch {}
  }
  if (hasResidualGitState(repoRoot)) {
    clearResidualGitState(repoRoot);
  }
}

function _trackedChanges(statusText) {
  if (!statusText || !statusText.trim()) return [];
  return statusText.split('\n').filter(Boolean).filter(l => !l.startsWith('?? '));
}

module.exports = { executeApply, _rollbackOrReport, _hardReset, _trackedChanges };
