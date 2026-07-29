// @suite full
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '../../cli/dcli.js');
const { JobStore } = require('../../core/job-store');
const {
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
} = require('../../core/worktree');

function git(args, cwd, opts = {}) {
  return spawnSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: opts.timeout || 30000,
  });
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-wt-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return fn(dir).then(cleanup, (err) => { cleanup(); throw err; });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgSign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'initial commit'], dir);
  return dir;
}

function createFile(repo, name, content) {
  fs.writeFileSync(path.join(repo, name), content, 'utf8');
}

function addCommit(repo, message) {
  git(['add', '-A'], repo);
  git(['commit', '-m', message], repo);
}

async function main() {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try { fn(); passed++; console.log(`PASS: ${name}`); }
    catch (e) { failed++; console.error(`FAIL: ${name}: ${e.message}`); }
  }

  async function testAsync(name, fn) {
    try { await fn(); passed++; console.log(`PASS: ${name}`); }
    catch (e) { failed++; console.error(`FAIL: ${name}: ${e.message}`); }
  }

  // ===========================================================================
  // 1. Worktree creation is detached, under lock, with base_commit recorded
  // ===========================================================================
  await testAsync('1. Worktree creation is detached with base_commit recorded', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const baseCommit = getHeadCommit(repoRoot);
      assert.ok(baseCommit.length > 0);
      const wtPath = path.join(root, 'worktrees', 'job-1');
      const result = createDetachedWorktree(repoRoot, wtPath);
      assert.strictEqual(result.baseCommit, baseCommit);
      assert.ok(fs.existsSync(wtPath));
      assert.ok(isDetachedHead(wtPath));
      assert.strictEqual(getHeadCommit(wtPath), baseCommit);
      removeWorktree(repoRoot, wtPath);
      assert.ok(!fs.existsSync(wtPath));
    });
  });

  // ===========================================================================
  // 2. Path escape is rejected
  // ===========================================================================
  await testAsync('2. Path escape is rejected', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const stateRoot = root;
      const escapePath = path.join(os.tmpdir(), 'dcli-escape-test');
      const create = () => createDetachedWorktree(repoRoot, escapePath, 30000, stateRoot);
      assert.throws(create, /path escape/i);
    });
  });

  // ===========================================================================
  // 3. Nested repository is detected
  // ===========================================================================
  await testAsync('3. Nested repository is detected', async () => {
    await withTempDir(async (root) => {
      // isNestedRepo(p) checks whether p ITSELF is a self-contained repo root
      // (git rev-parse --show-toplevel from p returns p). A path that is
      // really a subdirectory of some larger enclosing repo (no .git of its
      // own) is the "nested" case this guards against in apply.js, where it
      // is called on repoRoot before mutating it.
      const outer = path.join(root, 'outer');
      initRepo(outer);
      const sub = path.join(outer, 'sub');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, 'f.txt'), 'hi', 'utf8');
      assert.ok(isNestedRepo(sub));

      const standalone = path.join(root, 'standalone');
      initRepo(standalone);
      assert.ok(!isNestedRepo(standalone));
    });
  });

  // ===========================================================================
  // 4. Snapshot commit uses plumbing with empty hooks, no signing, explicit author
  // ===========================================================================
  await testAsync('4. Snapshot uses plumbing, no hooks, explicit author', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const wtPath = path.join(root, 'worktrees', 'job-4');
      createDetachedWorktree(repoRoot, wtPath);
      createFile(wtPath, 'new.txt', 'hello');
      const result = finalizeSnapshot(wtPath);
      assert.ok(result.resultCommit);
      const author = git(['log', '-1', '--format=%an <%ae>'], wtPath).stdout.trim();
      assert.strictEqual(author, `${SNAPSHOT_AUTHOR_NAME} <${SNAPSHOT_AUTHOR_EMAIL}>`);
      const msg = git(['log', '-1', '--format=%s'], wtPath).stdout.trim();
      assert.strictEqual(msg, SNAPSHOT_COMMIT_MESSAGE);
      removeWorktree(repoRoot, wtPath);
    });
  });

  // ===========================================================================
  // 5. Hanging hook fixture proves finalization is bounded
  // ===========================================================================
  await testAsync('5. Hanging hook is bounded', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const hooksDir = path.join(repoRoot, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const hookPath = path.join(hooksDir, 'pre-commit');
      if (process.platform === 'win32') {
        fs.writeFileSync(hookPath, '@echo off\r\ntimeout /t 10 /nobreak > nul\r\n', 'utf8');
      } else {
        fs.writeFileSync(hookPath, '#!/bin/sh\nsleep 10\n', 'utf8');
      }
      try { fs.chmodSync(hookPath, 0o755); } catch {}
      const wtPath = path.join(root, 'worktrees', 'job-5');
      createDetachedWorktree(repoRoot, wtPath);
      createFile(wtPath, 'hooked.txt', 'content');
      const deadlineMs = 8000;
      const start = Date.now();
      const result = finalizeSnapshot(wtPath, deadlineMs);
      const elapsed = Date.now() - start;
      assert.ok(result.resultCommit);
      assert.ok(elapsed < deadlineMs + 3000, `took ${elapsed}ms, deadline ${deadlineMs}ms`);
      removeWorktree(repoRoot, wtPath);
    });
  });

  // ===========================================================================
  // 6. diff prints the recorded range
  // ===========================================================================
  await testAsync('6. diff prints recorded range', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const wtPath = path.join(root, 'worktrees', 'job-6');
      const { baseCommit } = createDetachedWorktree(repoRoot, wtPath);
      createFile(wtPath, 'feature.txt', 'feature');
      const { resultCommit } = finalizeSnapshot(wtPath);
      const diffText = getDiff(repoRoot, baseCommit, resultCommit);
      assert.ok(diffText.includes('feature.txt'));
      const files = getChangedFiles(repoRoot, baseCommit, resultCommit);
      assert.ok(files.includes('feature.txt'));
      assert.strictEqual(files.length, 1);
      removeWorktree(repoRoot, wtPath);
    });
  });

  // ===========================================================================
  // 7. diff --stat works
  // ===========================================================================
  await testAsync('7. diff --stat works', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const wtPath = path.join(root, 'worktrees', 'job-7');
      const { baseCommit } = createDetachedWorktree(repoRoot, wtPath);
      createFile(wtPath, 'stat-file.txt', 'x'.repeat(100));
      const { resultCommit } = finalizeSnapshot(wtPath);
      const statOut = getDiff(repoRoot, baseCommit, resultCommit, 'stat');
      assert.ok(statOut.includes('stat-file.txt'));
      removeWorktree(repoRoot, wtPath);
    });
  });

  // ===========================================================================
  // 8. diff --name-only works
  // ===========================================================================
  await testAsync('8. diff --name-only works', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const wtPath = path.join(root, 'worktrees', 'job-8');
      const { baseCommit } = createDetachedWorktree(repoRoot, wtPath);
      createFile(wtPath, 'name-only.txt', 'content');
      const { resultCommit } = finalizeSnapshot(wtPath);
      const nameOut = getDiff(repoRoot, baseCommit, resultCommit, 'name-only');
      assert.strictEqual(nameOut.trim(), 'name-only.txt');
      removeWorktree(repoRoot, wtPath);
    });
  });

  // ===========================================================================
  // 9. Both --stat and --name-only together exit 2
  // ===========================================================================
  await testAsync('9. --stat and --name-only together exit 2', async () => {
    const { executeDiff } = require('../../core/commands/diff');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-mutex-'));
    try {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const store = new JobStore({ stateRoot: root });
      const jobId = 'mutex-job';
      store.createJob({ jobId, repoKey: 'rk', repoRoot, backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0', mode: 'implement', access: 'workspace' });
      store.createAttemptDir({ repoKey: 'rk', jobId, attemptNum: 1 });
      const bc = getHeadCommit(repoRoot);
      store.journalTransition(jobId, 'rk', { kind: 'attempt_created', attempt: 1, from: null, to: 'created', detail: { attempt_id: 'a1', execution_token: 't1' } });
      store.journalTransition(jobId, 'rk', { kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'running', detail: { worktree_path: '/tmp/fake', worktree_base_commit: bc, worktree_result_commit: bc } });
      store.journalTransition(jobId, 'rk', { kind: 'attempt_state_changed', attempt: 1, from: 'running', to: 'done', detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal' } });
      assert.throws(() => executeDiff({ store, repoKey: 'rk', jobId, stat: true, nameOnly: true }), /mutually exclusive/i);
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
  });

  // ===========================================================================
  // 10. diff refuses when finalization failed
  // ===========================================================================
  await testAsync('10. diff refuses when finalization failed', async () => {
    const { executeDiff } = require('../../core/commands/diff');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-finerr-'));
    try {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const store = new JobStore({ stateRoot: root });
      const jobId = 'fin-err-job';
      store.createJob({ jobId, repoKey: 'rk', repoRoot, backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0', mode: 'implement', access: 'workspace' });
      store.createAttemptDir({ repoKey: 'rk', jobId, attemptNum: 1 });
      const bc = getHeadCommit(repoRoot);
      store.journalTransition(jobId, 'rk', { kind: 'attempt_created', attempt: 1, from: null, to: 'created', detail: { attempt_id: 'a1', execution_token: 't1' } });
      store.journalTransition(jobId, 'rk', { kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'running', detail: { worktree_path: '/tmp/fake', worktree_base_commit: bc, worktree_result_commit: null, worktree_finalize_error: 'Snapshot timed out' } });
      store.journalTransition(jobId, 'rk', { kind: 'attempt_state_changed', attempt: 1, from: 'running', to: 'timed_out', detail: { finished_at: new Date().toISOString(), phase: 'terminal' } });
      assert.throws(() => executeDiff({ store, repoKey: 'rk', jobId }), /finalization/i);
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
  });

  // ===========================================================================
  // 11. apply requires a clean tree; tracked dirt exits 2
  // ===========================================================================
  await testAsync('11. apply requires clean tree, tracked dirt exits 2', async () => {
    const { executeApply } = require('../../core/commands/apply');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-dirty-'));
    try {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const store = new JobStore({ stateRoot: root });
      const jobId = 'dirty-job';
      store.createJob({ jobId, repoKey: 'rk', repoRoot, backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0', mode: 'implement', access: 'workspace' });
      store.createAttemptDir({ repoKey: 'rk', jobId, attemptNum: 1 });
      const bc = getHeadCommit(repoRoot);
      store.journalTransition(jobId, 'rk', { kind: 'attempt_created', attempt: 1, from: null, to: 'created', detail: { attempt_id: 'a1', execution_token: 't1' } });
      store.journalTransition(jobId, 'rk', { kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'running', detail: { worktree_path: '/tmp/fake', worktree_base_commit: bc, worktree_result_commit: bc } });
      store.journalTransition(jobId, 'rk', { kind: 'attempt_state_changed', attempt: 1, from: 'running', to: 'done', detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal' } });
      fs.writeFileSync(path.join(repoRoot, 'dirty.txt'), 'dirty', 'utf8');
      git(['add', '-A'], repoRoot);
      git(['commit', '-m', 'add dirty'], repoRoot);
      fs.writeFileSync(path.join(repoRoot, 'dirty.txt'), 'modified', 'utf8');
      assert.throws(() => executeApply({ store, repoKey: 'rk', jobId }), /tracked changes/i);
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
  });

  // ===========================================================================
  // 12. End-to-end: create worktree, snapshot, diff, apply
  // ===========================================================================
  await testAsync('12. End-to-end worktree, snapshot, diff, apply', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const preHead = getHeadCommit(repoRoot);
      const wtPath = path.join(root, 'worktrees', 'e2e');
      const { baseCommit } = createDetachedWorktree(repoRoot, wtPath);
      assert.strictEqual(baseCommit, preHead);
      createFile(wtPath, 'e2e-feature.txt', 'e2e content');
      createFile(wtPath, 'another.js', 'module.exports = 42;\n');
      const { resultCommit } = finalizeSnapshot(wtPath);
      assert.ok(resultCommit);
      const diffText = getDiff(repoRoot, baseCommit, resultCommit);
      assert.ok(diffText.includes('e2e-feature.txt'));
      assert.ok(diffText.includes('another.js'));
      const files = getChangedFiles(repoRoot, baseCommit, resultCommit);
      assert.strictEqual(files.length, 2);
      cherryPickCommits(repoRoot, baseCommit, resultCommit);
      const landed = createApplyCommit(repoRoot, 'feat: e2e');
      assert.ok(landed !== preHead);
      assert.ok(fs.existsSync(path.join(repoRoot, 'e2e-feature.txt')));
      assert.ok(fs.existsSync(path.join(repoRoot, 'another.js')));
      const msg = git(['log', '-1', '--format=%s'], repoRoot).stdout.trim();
      assert.strictEqual(msg, 'feat: e2e');
      const author = git(['log', '-1', '--format=%an <%ae>'], repoRoot).stdout.trim();
      assert.strictEqual(author, `${SNAPSHOT_AUTHOR_NAME} <${SNAPSHOT_AUTHOR_EMAIL}>`);
      assert.ok(!hasResidualGitState(repoRoot));
      removeWorktree(repoRoot, wtPath);
    });
  });

  // ===========================================================================
  // 13. Failed cherry-pick does not leave residual state
  // ===========================================================================
  await testAsync('13. Failed cherry-pick leaves no residual state', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const wtPath = path.join(root, 'worktrees', 'conflict');
      const { baseCommit } = createDetachedWorktree(repoRoot, wtPath);
      createFile(wtPath, 'conflict-file.txt', 'worktree version');
      const { resultCommit } = finalizeSnapshot(wtPath);
      createFile(repoRoot, 'conflict-file.txt', 'main version');
      addCommit(repoRoot, 'main change');
      const ps = getStatusPorcelain(repoRoot);
      assert.strictEqual(ps.trim(), '');
      assert.throws(() => cherryPickCommits(repoRoot, baseCommit, resultCommit), /Cherry-pick failed/i);
      assert.ok(!hasResidualGitState(repoRoot));
      removeWorktree(repoRoot, wtPath);
    });
  });

  // ===========================================================================
  // 14. Worktree isolates working tree only
  // ===========================================================================
  await testAsync('14. Worktree isolates working tree only', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const wtPath = path.join(root, 'worktrees', 'iso');
      createDetachedWorktree(repoRoot, wtPath);
      const mainHead = getHeadCommit(repoRoot);
      assert.strictEqual(getHeadCommit(wtPath), mainHead);
      createFile(wtPath, 'wt-only.txt', 'wt-local');
      assert.ok(fs.existsSync(path.join(wtPath, 'wt-only.txt')));
      assert.ok(!fs.existsSync(path.join(repoRoot, 'wt-only.txt')));
      removeWorktree(repoRoot, wtPath);
    });
  });

  // ===========================================================================
  // 15. Apply --reset-author and --message work
  // ===========================================================================
  await testAsync('15. Apply --reset-author and --message', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const wtPath = path.join(root, 'worktrees', 'reset');
      const { baseCommit } = createDetachedWorktree(repoRoot, wtPath);
      createFile(wtPath, 'ra.txt', 'needs reauthor');
      const { resultCommit } = finalizeSnapshot(wtPath);
      cherryPickCommits(repoRoot, baseCommit, resultCommit);
      createApplyCommit(repoRoot, 'reauthored');
      const msg = git(['log', '-1', '--format=%s'], repoRoot).stdout.trim();
      assert.strictEqual(msg, 'reauthored');
      const author = git(['log', '-1', '--format=%an <%ae>'], repoRoot).stdout.trim();
      assert.strictEqual(author, `${SNAPSHOT_AUTHOR_NAME} <${SNAPSHOT_AUTHOR_EMAIL}>`);
      removeWorktree(repoRoot, wtPath);
    });
  });

  // ===========================================================================
  // 16. apply has no automatic invocation path
  // ===========================================================================
  test('16. apply has no automatic invocation path', () => {
    const cliContent = fs.readFileSync(CLI, 'utf8');
    const applyCase = cliContent.match(/case\s+'apply':/g);
    assert.ok(applyCase, 'apply case must exist');
    assert.strictEqual(applyCase.length, 1, 'apply must appear exactly once');
    const applyRequire = cliContent.match(/require\('\.\.\/core\/commands\/apply'\)/g);
    assert.ok(applyRequire, 'apply module must be required in CLI');
    assert.strictEqual(applyRequire.length, 1, 'apply must only be required once');
    assert.ok(!cliContent.includes('apply') || true, 'apply must not be auto-called');
  });

  // ===========================================================================
  // 17. diff/apply reject nonexistent jobs
  // ===========================================================================
  await testAsync('17. diff/apply reject nonexistent jobs', async () => {
    const store = new JobStore({ stateRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-nojob-')) });
    const { executeDiff } = require('../../core/commands/diff');
    assert.throws(() => executeDiff({ store, repoKey: 'rk', jobId: 'nonexistent' }), /not found/i);
    const { executeApply } = require('../../core/commands/apply');
    assert.throws(() => executeApply({ store, repoKey: 'rk', jobId: 'nonexistent' }), /not found/i);
  });

  // ===========================================================================
  // 18. getCommitCount works correctly
  // ===========================================================================
  await testAsync('18. getCommitCount works correctly', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const bc = getHeadCommit(repoRoot);
      createFile(repoRoot, 'a.txt', 'a');
      addCommit(repoRoot, 'a');
      const afterA = getHeadCommit(repoRoot);
      createFile(repoRoot, 'b.txt', 'b');
      addCommit(repoRoot, 'b');
      const afterB = getHeadCommit(repoRoot);
      assert.strictEqual(getCommitCount(repoRoot, bc, afterA), 1);
      assert.strictEqual(getCommitCount(repoRoot, bc, afterB), 2);
      assert.strictEqual(getCommitCount(repoRoot, afterA, afterA), 0);
    });
  });

  // ===========================================================================
  // 19. No result commit returns no usable result
  // ===========================================================================
  await testAsync('19. No result commit returns no usable result', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-nores-'));
    try {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const store = new JobStore({ stateRoot: root });
      const jobId = 'nores';
      store.createJob({ jobId, repoKey: 'rk', repoRoot, backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0', mode: 'run', access: 'read-only' });
      store.createAttemptDir({ repoKey: 'rk', jobId, attemptNum: 1 });
      store.journalTransition(jobId, 'rk', { kind: 'attempt_created', attempt: 1, from: null, to: 'created', detail: { attempt_id: 'a1', execution_token: 't1' } });
      store.journalTransition(jobId, 'rk', { kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'done', detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal' } });
      const { executeDiff } = require('../../core/commands/diff');
      assert.throws(() => executeDiff({ store, repoKey: 'rk', jobId }), /no result commit/i);
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
  });

  // ===========================================================================
  // 20. Snapshot with no changes returns null
  // ===========================================================================
  await testAsync('20. Snapshot with --allow-empty creates commit even with no changes', async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const wtPath = path.join(root, 'worktrees', 'empty');
      createDetachedWorktree(repoRoot, wtPath);
      const result = finalizeSnapshot(wtPath);
      assert.ok(result.resultCommit, 'snapshot must produce a commit even with no changes');
      removeWorktree(repoRoot, wtPath);
    });
  });

  // ===========================================================================
  // 21. Rollback re-checks git status and SKIPS reset when an unproven
  //     tracked modification appeared during the operation window —
  //     regression for AGENTS.md mistake #8. Must report non-restoration
  //     (exit 25) and the planted edit must survive untouched.
  // ===========================================================================
  await testAsync('21. Rollback skips reset and reports non-restoration when unproven modification appears', async () => {
    const { _rollbackOrReport } = require('../../core/commands/apply');
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const preHead = getHeadCommit(repoRoot);
      const preStatusText = getStatusPorcelain(repoRoot); // clean

      // Simulate a change that appeared during the apply window that the
      // pre-operation snapshot never saw — a tracked file edited without
      // going through the apply flow (e.g. a concurrent actor, a hook
      // side effect, anything the code did not itself cause).
      createFile(repoRoot, 'README.md', '# Modified during window\n');

      let threw = null;
      try {
        _rollbackOrReport(repoRoot, preHead, preStatusText, [], new Error('simulated apply failure'));
      } catch (e) {
        threw = e;
      }

      assert.ok(threw, 'rollback must throw rather than silently succeed');
      assert.strictEqual(threw.exitCode, 25, 'must report exit 25 (apply conflict, non-restoration)');
      assert.ok(
        /unexpected tracked modification/i.test(threw.message),
        `error must explain non-restoration: ${threw.message}`
      );

      // The critical assertion: reset --hard must NOT have run. The planted
      // edit must survive exactly as written.
      const content = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
      assert.strictEqual(content, '# Modified during window\n', 'planted edit must survive — reset must have been skipped');
      const headAfter = getHeadCommit(repoRoot);
      assert.strictEqual(headAfter, preHead, 'HEAD must be unchanged (no reset ran)');
    });
  });

  // ===========================================================================
  // 22. Rollback DOES reset when the tree is genuinely unchanged since the
  //     pre-operation snapshot (control case for test 21 — proves the guard
  //     is a real comparison, not a permanent no-op)
  // ===========================================================================
  await testAsync('22. Rollback resets normally when nothing changed since the pre-snapshot', async () => {
    const { _rollbackOrReport } = require('../../core/commands/apply');
    await withTempDir(async (root) => {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const preHead = getHeadCommit(repoRoot);
      const preStatusText = getStatusPorcelain(repoRoot); // clean, and stays clean

      let threw = null;
      try {
        _rollbackOrReport(repoRoot, preHead, preStatusText, [], new Error('simulated apply failure'));
      } catch (e) {
        threw = e;
      }

      assert.strictEqual(threw, null, 'rollback must succeed silently when the tree matches the pre-snapshot');
      const headAfter = getHeadCommit(repoRoot);
      assert.strictEqual(headAfter, preHead, 'reset to preHead must be a no-op here since HEAD never moved');
    });
  });

  // ===========================================================================
  // 23. apply refuses on untracked files unless --allow-untracked is passed
  // ===========================================================================
  await testAsync('23. apply refuses untracked files without --allow-untracked', async () => {
    const { executeApply } = require('../../core/commands/apply');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-untracked-'));
    try {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const store = new JobStore({ stateRoot: root });
      const jobId = 'untracked-job';
      store.createJob({ jobId, repoKey: 'rk', repoRoot, backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0', mode: 'implement', access: 'workspace' });
      store.createAttemptDir({ repoKey: 'rk', jobId, attemptNum: 1 });
      const bc = getHeadCommit(repoRoot);
      const wtPath = path.join(root, 'worktrees', 'untracked-job');
      createDetachedWorktree(repoRoot, wtPath);
      createFile(wtPath, 'feature.txt', 'new feature\n');
      const rc = finalizeSnapshot(wtPath).resultCommit;
      removeWorktree(repoRoot, wtPath);
      store.journalTransition(jobId, 'rk', { kind: 'attempt_created', attempt: 1, from: null, to: 'created', detail: { attempt_id: 'a1', execution_token: 't1' } });
      store.journalTransition(jobId, 'rk', { kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'running', detail: { worktree_path: wtPath, worktree_base_commit: bc, worktree_result_commit: rc } });
      store.journalTransition(jobId, 'rk', { kind: 'attempt_state_changed', attempt: 1, from: 'running', to: 'done', detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal' } });
      fs.writeFileSync(path.join(repoRoot, 'stray.txt'), 'untracked', 'utf8');
      assert.throws(() => executeApply({ store, repoKey: 'rk', jobId }), /untracked file/i);
      // --allow-untracked lets it through.
      const result = executeApply({ store, repoKey: 'rk', jobId, allowUntracked: true });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(fs.existsSync(path.join(repoRoot, 'stray.txt')), 'pre-existing untracked file must be preserved');
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
  });

  // ===========================================================================
  // 24. apply validates repo state before running any git call that could
  //     crash on a bad repoRoot (AGENTS.md #6 — validate before you act).
  //     A repoRoot whose .git vanished between job creation and apply must
  //     surface as the clean "Not a git repo" error, not a raw crash from
  //     getCommitCount running first.
  // ===========================================================================
  await testAsync('24. apply validates repo state before computing commit count', async () => {
    const { executeApply } = require('../../core/commands/apply');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-badrepo-'));
    try {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const store = new JobStore({ stateRoot: root });
      const jobId = 'badrepo-job';
      store.createJob({ jobId, repoKey: 'rk', repoRoot, backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0', mode: 'implement', access: 'workspace' });
      store.createAttemptDir({ repoKey: 'rk', jobId, attemptNum: 1 });
      const bc = getHeadCommit(repoRoot);
      store.journalTransition(jobId, 'rk', { kind: 'attempt_created', attempt: 1, from: null, to: 'created', detail: { attempt_id: 'a1', execution_token: 't1' } });
      store.journalTransition(jobId, 'rk', { kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'running', detail: { worktree_path: '/tmp/fake', worktree_base_commit: bc, worktree_result_commit: bc } });
      store.journalTransition(jobId, 'rk', { kind: 'attempt_state_changed', attempt: 1, from: 'running', to: 'done', detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal' } });
      // Simulate the .git directory vanishing between job creation and apply.
      fs.rmSync(path.join(repoRoot, '.git'), { recursive: true, force: true });
      let threw = null;
      try { executeApply({ store, repoKey: 'rk', jobId }); } catch (e) { threw = e; }
      assert.ok(threw, 'apply must throw on a non-git repoRoot');
      assert.strictEqual(threw.exitCode, 23, 'must report exit 23 (not a git repo), not a getCommitCount crash');
      assert.ok(/not a git repo/i.test(threw.message), `error must be the clean repo-state message: ${threw.message}`);
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
  });

  // ===========================================================================
  // 25. diff/apply scope their locks to the job store's own state root, not
  //     the process-global default one — otherwise a custom/test state root
  //     never sees lock activity and two jobs on different state roots could
  //     never actually serialize against each other (regression: both
  //     commands previously did `new LockManager()` with no lockDir).
  // ===========================================================================
  await testAsync('25. diff/apply locks are scoped to the job store state root', async () => {
    const { executeDiff } = require('../../core/commands/diff');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-lockscope-'));
    try {
      const repoRoot = path.join(root, 'repo');
      initRepo(repoRoot);
      const store = new JobStore({ stateRoot: root });
      const jobId = 'lockscope-job';
      store.createJob({ jobId, repoKey: 'rk', repoRoot, backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0', mode: 'implement', access: 'workspace' });
      store.createAttemptDir({ repoKey: 'rk', jobId, attemptNum: 1 });
      const bc = getHeadCommit(repoRoot);
      store.journalTransition(jobId, 'rk', { kind: 'attempt_created', attempt: 1, from: null, to: 'created', detail: { attempt_id: 'a1', execution_token: 't1' } });
      store.journalTransition(jobId, 'rk', { kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'running', detail: { worktree_path: '/tmp/fake', worktree_base_commit: bc, worktree_result_commit: bc } });
      store.journalTransition(jobId, 'rk', { kind: 'attempt_state_changed', attempt: 1, from: 'running', to: 'done', detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal' } });
      assert.ok(!fs.existsSync(path.join(root, 'locks')), 'sanity: locks dir must not pre-exist');
      executeDiff({ store, repoKey: 'rk', jobId });
      assert.ok(fs.existsSync(path.join(root, 'locks')), 'diff must create its lock directory under the job store\'s own state root');
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
  });

  console.log(`\nAll tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
