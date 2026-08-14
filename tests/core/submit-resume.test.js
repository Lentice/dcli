// @suite full
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { JobStore } = require('../../core/job-store');
const { computeRepoKeyWithPath } = require('../../core/repo-key');

const CLI = path.resolve(__dirname, '../../cli/dcli.js');
const TERMINAL = new Set(['done', 'failed', 'timed_out', 'cancelled', 'interrupted']);

function git(repoRoot, args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function cli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    env: { ...process.env, ...env },
  });
}

async function waitForTerminal(stateRoot, repoRoot, jobId) {
  const { repoKey } = computeRepoKeyWithPath(repoRoot);
  const store = new JobStore({ stateRoot });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const status = store.readStatus({ repoKey, jobId });
      if (TERMINAL.has(status.state)) return status;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`job ${jobId} did not become terminal`);
}

function submit(args, env) {
  const result = cli(['--backend', 'fake', 'submit', '--repo', env.repoRoot, '--hard-timeout-sec', '60', ...args], env);
  assert.strictEqual(result.status, 0, `submit failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-submit-resume-'));
  const repoRoot = path.join(root, 'repo');
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoRoot, 'base.txt'), 'base\n', 'utf8');
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-m', 'base']);
  const head = git(repoRoot, ['rev-parse', 'HEAD']);
  const env = { stateRoot, repoRoot, DCLI_STATE_ROOT: stateRoot, DCLI_FAKE_WRITE_FILE: 'child.txt' };

  try {
    const parent = submit(['--mode', 'implement', '--access', 'workspace', 'parent'], env);
    const parentStatus = await waitForTerminal(stateRoot, repoRoot, parent);
    assert.strictEqual(parentStatus.state, 'done');
    assert.ok(parentStatus.worktree.result_commit, 'parent must have a result commit');

    const child = submit(['--resume', parent, '--mode', 'implement', '--access', 'workspace', 'child'], env);
    const { repoKey } = computeRepoKeyWithPath(repoRoot);
    const store = new JobStore({ stateRoot });
    const childParams = JSON.parse(fs.readFileSync(
      path.join(stateRoot, 'jobs', repoKey, child, 'params.json'), 'utf8',
    ));
    assert.strictEqual(childParams.worktreeBaseCommit, parentStatus.worktree.result_commit);
    assert.strictEqual(store.readStatus({ repoKey, jobId: child }).session_strategy, 'fork_from_artifacts');
    assert.strictEqual((await waitForTerminal(stateRoot, repoRoot, child)).state, 'done');

    const runStateRoot = path.join(root, 'run-state');
    const runEnv = { stateRoot: runStateRoot, DCLI_STATE_ROOT: runStateRoot, repoRoot };
    const parentWithoutWorktree = submit(['parent without worktree'], runEnv);
    const runParentStatus = await waitForTerminal(runStateRoot, repoRoot, parentWithoutWorktree);
    assert.ok(!runParentStatus.worktree.result_commit, 'run-mode parent must have no result commit');
    const fallbackChild = submit(['--resume', parentWithoutWorktree, '--mode', 'implement', '--access', 'workspace', 'fallback'], runEnv);
    const fallbackParams = JSON.parse(fs.readFileSync(
      path.join(runStateRoot, 'jobs', repoKey, fallbackChild, 'params.json'), 'utf8',
    ));
    assert.strictEqual(fallbackParams.worktreeBaseCommit, head);
    assert.strictEqual(new JobStore({ stateRoot: runStateRoot }).readStatus({ repoKey, jobId: fallbackChild }).session_strategy, 'fork_from_artifacts');
    assert.strictEqual((await waitForTerminal(runStateRoot, repoRoot, fallbackChild)).state, 'done');

    const kindStateRoot = path.join(root, 'kind-state');
    const rejected = cli([
      '--backend', 'fake', 'submit', '--repo', repoRoot, '--kind', 'retry_attempt',
      '--hard-timeout-sec', '60', 'invalid submit kind',
    ], { DCLI_STATE_ROOT: kindStateRoot });
    assert.strictEqual(rejected.status, 2);
    assert.match(rejected.stderr, /--kind.*resume/);
    console.log('PASS: submit --resume seeds result commit and rejects --kind');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
