const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SNAPSHOT_COMMIT_MESSAGE = 'dcli snapshot';
const SNAPSHOT_AUTHOR_NAME = 'dcli';
const SNAPSHOT_AUTHOR_EMAIL = 'dcli@localhost';

function _git(args, opts = {}) {
  const { cwd, timeoutMs = 30000, env } = opts;
  const spawnOpts = {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  };
  if (env) spawnOpts.env = env;
  const result = spawnSync('git', args, spawnOpts);
  return result;
}

function _gitOk(args, opts = {}) {
  const result = _git(args, opts);
  if (result.error) {
    const err = new Error(`git ${args[0]} failed: ${result.error.message}`);
    err.exitCode = 23;
    throw err;
  }
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').trim();
    const err = new Error(`git ${args[0]} exited ${result.status}: ${msg}`);
    err.exitCode = 23;
    err.gitCode = result.status;
    err.gitStderr = result.stderr;
    throw err;
  }
  return result;
}

function revParse(ref, cwd) {
  return _gitOk(['rev-parse', ref], { cwd }).stdout.trim();
}

function getHeadCommit(cwd) {
  return revParse('HEAD', cwd);
}

function isGitRepo(cwd) {
  const result = _git(['rev-parse', '--git-dir'], { cwd });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function hasUnresolvedConflicts(cwd) {
  const result = _gitOk(['ls-files', '-u'], { cwd });
  return result.stdout.trim().length > 0;
}

function isDetachedHead(cwd) {
  const result = _gitOk(['rev-parse', '--symbolic-full-name', 'HEAD'], { cwd });
  return result.stdout.trim() === 'HEAD';
}

function isDirty(cwd) {
  const result = _gitOk(['status', '--porcelain'], { cwd });
  return result.stdout.trim().length > 0;
}

function isNestedRepo(worktreePath) {
  const result = _git(['rev-parse', '--show-toplevel'], { cwd: worktreePath });
  if (result.status !== 0) return true;
  // Windows can resolve the same directory to different strings depending
  // on whether a path segment came through a short (8.3) name — e.g.
  // os.tmpdir() returning "LENTIC~1" while git's own output resolves the
  // real "lenticetsai" long form. Canonicalize both sides before comparing
  // or every repo under such a path falsely registers as nested.
  let topLevel = path.resolve(result.stdout.trim());
  let expected = path.resolve(worktreePath);
  try { topLevel = fs.realpathSync.native(topLevel); } catch {}
  try { expected = fs.realpathSync.native(expected); } catch {}
  if (topLevel.toLowerCase() !== expected.toLowerCase()) return true;
  return false;
}

function validateTree(cwd) {
  if (!isGitRepo(cwd)) {
    const err = new Error(`Not a git repository: ${cwd}`);
    err.exitCode = 23;
    throw err;
  }
  if (hasUnresolvedConflicts(cwd)) {
    const err = new Error(`Repository has unresolved conflicts: ${cwd}`);
    err.exitCode = 23;
    throw err;
  }
}

function validateNoPathEscape(worktreePath, stateRoot) {
  const resolvedWorktree = path.resolve(worktreePath);
  const resolvedStateRoot = path.resolve(stateRoot);
  if (!resolvedWorktree.startsWith(resolvedStateRoot + path.sep) &&
      resolvedWorktree !== resolvedStateRoot) {
    const err = new Error(`Worktree path escapes state root: ${resolvedWorktree}`);
    err.exitCode = 23;
    throw err;
  }
}

function createDetachedWorktree(repoRoot, worktreePath, timeoutMs, stateRoot) {
  validateTree(repoRoot);
  if (stateRoot) {
    validateNoPathEscape(worktreePath, stateRoot);
  }

  if (fs.existsSync(worktreePath)) {
    const err = new Error(`Worktree path already exists: ${worktreePath}`);
    err.exitCode = 23;
    throw err;
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  const baseCommit = getHeadCommit(repoRoot);

  _gitOk(['worktree', 'add', '--detach', worktreePath, 'HEAD'], { cwd: repoRoot, timeoutMs });

  return { baseCommit, worktreePath };
}

function removeWorktree(repoRoot, worktreePath, timeoutMs) {
  try {
    _git(['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot, timeoutMs });
  } catch {
  }
  try {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  } catch {
  }
}

function stageAll(worktreePath, timeoutMs) {
  _gitOk(['add', '-A'], { cwd: worktreePath, timeoutMs });
}

function snapshotCommit(worktreePath, timeoutMs) {
  stageAll(worktreePath, timeoutMs);

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: SNAPSHOT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: SNAPSHOT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: SNAPSHOT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: SNAPSHOT_AUTHOR_EMAIL,
  };

  const result = _git([
    '-c', 'core.hooksPath=',
    '-c', 'commit.gpgSign=false',
    '-c', 'tag.gpgSign=false',
    'commit', '--no-verify',
    '--allow-empty',
    '-m', SNAPSHOT_COMMIT_MESSAGE,
  ], { cwd: worktreePath, timeoutMs, env });

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    if (stderr.includes('nothing to commit') || stderr.includes('nothing added')) {
      return null;
    }
    const err = new Error(`Snapshot commit failed: ${stderr}`);
    err.exitCode = 23;
    throw err;
  }

  const commitHash = revParse('HEAD', worktreePath);
  return commitHash;
}

function finalizeSnapshot(worktreePath, deadlineMs) {
  const commitHash = snapshotCommit(worktreePath, deadlineMs);
  return { resultCommit: commitHash };
}

function getChangedFiles(repoRoot, baseCommit, resultCommit, timeoutMs) {
  const result = _gitOk(['diff', '--name-only', `${baseCommit}..${resultCommit}`], { cwd: repoRoot, timeoutMs });
  const stdout = result.stdout.trim();
  if (!stdout) return [];
  return stdout.split('\n').filter(Boolean);
}

function getDiff(repoRoot, baseCommit, resultCommit, format, timeoutMs) {
  const args = ['diff'];
  if (format === 'stat') {
    args.push('--stat');
  } else if (format === 'name-only') {
    args.push('--name-only');
  }
  args.push(`${baseCommit}..${resultCommit}`);
  const result = _gitOk(args, { cwd: repoRoot, timeoutMs });
  return result.stdout;
}

function isCherryPickInProgress(cwd) {
  return fs.existsSync(path.join(cwd, '.git', 'CHERRY_PICK_HEAD'));
}

function isRebaseInProgress(cwd) {
  return fs.existsSync(path.join(cwd, '.git', 'REBASE_HEAD')) ||
         fs.existsSync(path.join(cwd, '.git', 'rebase-apply')) ||
         fs.existsSync(path.join(cwd, '.git', 'rebase-merge'));
}

function isAmInProgress(cwd) {
  return fs.existsSync(path.join(cwd, '.git', 'rebase-apply'));
}

function hasResidualGitState(cwd) {
  return isCherryPickInProgress(cwd) || isRebaseInProgress(cwd) || isAmInProgress(cwd);
}

function clearResidualGitState(cwd) {
  if (isCherryPickInProgress(cwd)) {
    _git(['cherry-pick', '--abort'], { cwd });
  }
  if (isRebaseInProgress(cwd)) {
    _git(['rebase', '--abort'], { cwd });
  }
  if (isAmInProgress(cwd)) {
    _git(['am', '--abort'], { cwd });
  }
}

function getStatusPorcelain(cwd) {
  const result = _gitOk(['status', '--porcelain'], { cwd });
  return result.stdout;
}

function getUntrackedFilesFromStatus(statusText) {
  if (!statusText || !statusText.trim()) return [];
  const lines = statusText.split('\n').filter(Boolean);
  const untracked = [];
  for (const line of lines) {
    if (line.startsWith('?? ')) {
      untracked.push(line.slice(3));
    }
  }
  return untracked;
}

function getTrackedChangesFromStatus(statusText) {
  if (!statusText || !statusText.trim()) return [];
  const lines = statusText.split('\n').filter(Boolean);
  const tracked = [];
  for (const line of lines) {
    if (!line.startsWith('?? ')) {
      tracked.push(line);
    }
  }
  return tracked;
}

function cherryPickCommits(repoRoot, baseCommit, resultCommit, timeoutMs) {
  const args = ['cherry-pick', '--no-commit', `${baseCommit}..${resultCommit}`];
  const result = _git(args, { cwd: repoRoot, timeoutMs });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    _git(['cherry-pick', '--abort'], { cwd: repoRoot });
    const err = new Error(`Cherry-pick failed: ${stderr}`);
    err.exitCode = 25;
    err.gitStderr = stderr;
    throw err;
  }
}

function createApplyCommit(repoRoot, message, timeoutMs) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: SNAPSHOT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: SNAPSHOT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: SNAPSHOT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: SNAPSHOT_AUTHOR_EMAIL,
  };

  const args = [
    '-c', 'core.hooksPath=',
    '-c', 'commit.gpgSign=false',
    'commit', '--no-verify',
  ];
  if (message) {
    args.push('-m', message);
  } else {
    args.push('-m', SNAPSHOT_COMMIT_MESSAGE);
  }

  const result = _git(args, { cwd: repoRoot, timeoutMs, env });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const err = new Error(`Apply commit failed: ${stderr}`);
    err.exitCode = 25;
    throw err;
  }
  return revParse('HEAD', repoRoot);
}

function getCommitCount(repoRoot, baseCommit, resultCommit, timeoutMs) {
  const args = ['rev-list', '--count', `${baseCommit}..${resultCommit}`];
  const result = _gitOk(args, { cwd: repoRoot, timeoutMs });
  return parseInt(result.stdout.trim(), 10);
}

module.exports = {
  SNAPSHOT_COMMIT_MESSAGE,
  SNAPSHOT_AUTHOR_NAME,
  SNAPSHOT_AUTHOR_EMAIL,
  isGitRepo,
  hasUnresolvedConflicts,
  isDetachedHead,
  isDirty,
  isNestedRepo,
  validateTree,
  createDetachedWorktree,
  removeWorktree,
  stageAll,
  snapshotCommit,
  finalizeSnapshot,
  getChangedFiles,
  getDiff,
  isCherryPickInProgress,
  isRebaseInProgress,
  isAmInProgress,
  hasResidualGitState,
  clearResidualGitState,
  getStatusPorcelain,
  getUntrackedFilesFromStatus,
  getTrackedChangesFromStatus,
  cherryPickCommits,
  createApplyCommit,
  getCommitCount,
  revParse,
  getHeadCommit,
};
