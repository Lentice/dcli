// @suite full
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { DEFAULT_TIMEOUT } = require('../run-tests');

const { JobStore } = require('../../core/job-store');
const { LockManager, LOCK_SCOPES } = require('../../core/locking');
const { executeCleanup } = require('../../core/commands/cleanup');
const { loadJobOrThrow } = require('../../core/commands/index');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: DEFAULT_TIMEOUT });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function createRepo(root) {
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  git(['init', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 'test@test.com'], repoRoot);
  git(['config', 'user.name', 'Test'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# cleanup\n', 'utf8');
  git(['add', '-A'], repoRoot);
  git(['commit', '--no-verify', '-m', 'initial'], repoRoot);
  return repoRoot;
}

function createWorktree(repoRoot, worktreePath) {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(['worktree', 'add', '--detach', worktreePath, 'HEAD'], repoRoot);
  return git(['rev-parse', 'HEAD'], repoRoot);
}

function hasWorktree(repoRoot, worktreePath) {
  const normalize = (target) => {
    try { return fs.realpathSync.native(target).toLowerCase(); } catch {}
    return path.resolve(target).toLowerCase();
  };
  const wanted = normalize(worktreePath);
  return git(['worktree', 'list', '--porcelain'], repoRoot)
    .split(/\r?\n/)
    .filter(line => line.startsWith('worktree '))
    .some(line => normalize(line.slice('worktree '.length)) === wanted);
}

function createTerminalImplementJob(store, { repoKey, jobId, repoRoot, worktreePath, baseCommit }) {
  store.createJob({
    jobId, repoKey, repoRoot,
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'implement', access: 'workspace', hardTimeoutSec: 60,
  });
  store.createAttemptDir({ repoKey, jobId, attemptNum: 1 });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created', attempt: 1, from: null, to: 'created',
    detail: { attempt_id: 'a1', execution_token: `tok-${jobId}` },
  });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'running',
    detail: { started_at: new Date(Date.now() - 5000).toISOString(), phase: 'agent_running' },
  });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'running', to: 'done',
    detail: {
      finished_at: new Date().toISOString(), command_exit_code: 0, result_bytes: 1,
      phase: 'terminal', worktree_path: worktreePath,
      worktree_base_commit: baseCommit, worktree_result_commit: baseCommit,
    },
  });
}

function createExpiredIdentitylessJob(store, { repoKey, jobId, repoRoot, worktreePath, baseCommit }) {
  store.createJob({
    jobId, repoKey, repoRoot,
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'implement', access: 'workspace', hardTimeoutSec: 1,
  });
  store.createAttemptDir({ repoKey, jobId, attemptNum: 1 });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created', attempt: 1, from: null, to: 'created',
    detail: { attempt_id: 'a1', execution_token: `tok-${jobId}` },
  });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'running',
    detail: {
      started_at: new Date(Date.now() - 60000).toISOString(), phase: 'agent_running',
      worktree_path: worktreePath, worktree_base_commit: baseCommit,
    },
  });
  store.journalTransition(jobId, repoKey, {
    kind: 'heartbeat', attempt: null, from: null, to: null,
    detail: { heartbeat_at: new Date(Date.now() - 600000).toISOString() },
  });
}

function cleanupTree(root, repoRoot, worktreePaths) {
  for (const worktreePath of worktreePaths) {
    try { spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot, windowsHide: true, timeout: DEFAULT_TIMEOUT }); } catch {}
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

async function main() {
// A real worktree is removed from both disk and git registration, and preview
// reports the same artifact and byte count as the subsequent real run.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-cleanup-wt-'));
  const stateRoot = path.join(root, 'state');
  const repoRoot = createRepo(root);
  const worktreePath = path.join(stateRoot, 'worktrees', 'cleanup-job');
  const baseCommit = createWorktree(repoRoot, worktreePath);
  const store = new JobStore({ stateRoot });
  createTerminalImplementJob(store, {
    repoKey: 'repo-key', jobId: 'cleanup-job', repoRoot, worktreePath, baseCommit,
  });

  try {
    const preview = await executeCleanup({ store, dryRun: true });
    assert.strictEqual(preview.removed, 1);
    assert.strictEqual(preview.worktrees.length, 1);
    assert.ok(preview.worktrees[0].bytes > 0);
    assert.strictEqual(preview.worktrees[0].path, worktreePath);
    assert.ok(fs.existsSync(worktreePath), 'dry-run must keep the worktree');
    assert.ok(hasWorktree(repoRoot, worktreePath), 'dry-run must keep git registration');

    const result = await executeCleanup({ store });
    assert.strictEqual(result.removed, preview.removed);
    assert.strictEqual(result.worktrees.length, preview.worktrees.length);
    assert.strictEqual(result.worktrees[0].bytes, preview.worktrees[0].bytes);
    assert.ok(!fs.existsSync(worktreePath), 'cleanup must remove the worktree directory');
    assert.ok(!hasWorktree(repoRoot, worktreePath), 'cleanup must unregister the worktree');
    assert.ok(!fs.existsSync(store.getJobDir('repo-key', 'cleanup-job')), 'cleanup must remove the job record');
  } finally {
    cleanupTree(root, repoRoot, [worktreePath]);
  }
}

// An identityless legacy job becomes terminal on read, then cleanup removes
// its worktree with the job record.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-cleanup-identityless-'));
  const stateRoot = path.join(root, 'state');
  const repoRoot = createRepo(root);
  const worktreePath = path.join(stateRoot, 'worktrees', 'identityless-cleanup');
  const baseCommit = createWorktree(repoRoot, worktreePath);
  const store = new JobStore({ stateRoot });
  createExpiredIdentitylessJob(store, {
    repoKey: 'repo-key', jobId: 'identityless-cleanup', repoRoot, worktreePath, baseCommit,
  });

  try {
    const { status } = loadJobOrThrow({ store, repoKey: 'repo-key', jobId: 'identityless-cleanup' });
    assert.strictEqual(status.state, 'interrupted');
    const result = await executeCleanup({ store });
    assert.strictEqual(result.removed, 1, 'resolved identityless jobs must be cleanup-eligible');
    assert.ok(!fs.existsSync(worktreePath), 'cleanup must remove the resolved job worktree');
    assert.ok(!fs.existsSync(store.getJobDir('repo-key', 'identityless-cleanup')),
      'cleanup must remove the resolved job record');
  } finally {
    cleanupTree(root, repoRoot, [worktreePath]);
  }
}

// A directory without a surviving job record is still a dcli artifact and is
// discoverable/removable through the same command.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-cleanup-orphan-'));
  const stateRoot = path.join(root, 'state');
  const repoRoot = createRepo(root);
  const worktreePath = path.join(stateRoot, 'worktrees', 'orphan-job');
  createWorktree(repoRoot, worktreePath);
  const store = new JobStore({ stateRoot });

  try {
    const preview = await executeCleanup({ store, dryRun: true });
    assert.strictEqual(preview.removed, 0);
    assert.strictEqual(preview.worktrees.length, 1);
    assert.strictEqual(preview.worktrees[0].orphan, true);
    assert.strictEqual(preview.worktrees[0].path, worktreePath);

    const result = await executeCleanup({ store });
    assert.strictEqual(result.worktrees.length, 1);
    assert.ok(!fs.existsSync(worktreePath));
    assert.ok(!hasWorktree(repoRoot, worktreePath));
  } finally {
    cleanupTree(root, repoRoot, [worktreePath]);
  }
}

// A diff-held lease protects the worktree; cleanup names the skipped artifact.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-cleanup-lock-'));
  const stateRoot = path.join(root, 'state');
  const repoRoot = createRepo(root);
  const worktreePath = path.join(stateRoot, 'worktrees', 'leased-job');
  const baseCommit = createWorktree(repoRoot, worktreePath);
  const store = new JobStore({ stateRoot });
  createTerminalImplementJob(store, {
    repoKey: 'repo-key', jobId: 'leased-job', repoRoot, worktreePath, baseCommit,
  });
  const locks = new LockManager({ lockDir: path.join(stateRoot, 'locks') });
  const lease = locks.acquire(LOCK_SCOPES.JOB_LEASE, 'leased-job', { operation: 'test-reader' });

  try {
    const result = await executeCleanup({ store });
    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.skipped, 1);
    assert.ok(result.skippedItems.some(item => item.name.includes('leased-job')));
    assert.ok(fs.existsSync(worktreePath));
    assert.ok(hasWorktree(repoRoot, worktreePath));

    locks.release(lease);
    const repoLock = locks.acquire(LOCK_SCOPES.APPLY, 'repo-key', { operation: 'test-repo-reader' });
    try {
      const repoResult = await executeCleanup({ store });
      assert.strictEqual(repoResult.removed, 0);
      assert.strictEqual(repoResult.skipped, 1);
      assert.ok(repoResult.skippedItems.some(item => item.name.includes('leased-job')));
    } finally {
      locks.release(repoLock);
    }
  } finally {
    locks.release(lease);
    cleanupTree(root, repoRoot, [worktreePath]);
  }
}

// A failed worktree removal is reported and does not count as a removed job.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-cleanup-fail-'));
  const stateRoot = path.join(root, 'state');
  const repoRoot = createRepo(root);
  const missingWorktreePath = path.join(stateRoot, 'worktrees', 'missing-job');
  const store = new JobStore({ stateRoot });
  createTerminalImplementJob(store, {
    repoKey: 'repo-key', jobId: 'missing-job', repoRoot,
    worktreePath: missingWorktreePath, baseCommit: git(['rev-parse', 'HEAD'], repoRoot),
  });

  try {
    const result = await executeCleanup({ store });
    assert.strictEqual(result.removed, 0);
    assert.ok(result.errors.some(error => error.includes('missing-job')));
    assert.ok(fs.existsSync(store.getJobDir('repo-key', 'missing-job')));
  } finally {
    cleanupTree(root, repoRoot, [missingWorktreePath]);
  }
}

console.log('All cleanup worktree tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
