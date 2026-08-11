// @suite full
// Ticket 110: submit must release the job's worktree when the detached worker
// cannot launch, whether spawn throws or the child reports an error.
const assert = require('node:assert');
const childProcess = require('node:child_process');
const { spawnSync } = childProcess;
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalSpawn = childProcess.spawn;
let spawnMode = 'throw';
childProcess.spawn = () => {
  if (spawnMode === 'throw') throw new Error('injected worker spawn failure');
  const child = new EventEmitter();
  child.pid = process.pid;
  child.unref = () => {};
  process.nextTick(() => child.emit('error', new Error('injected worker error')));
  return child;
};

const { JobStore } = require('../../core/job-store');
const { executeSubmit } = require('../../core/commands/submit');
const { FakeAdapter } = require('../../adapters/fake/adapter');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function createRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  git(['init', '-b', 'main'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'Test'], root);
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n', 'utf8');
  git(['add', '-A'], root);
  git(['commit', '-m', 'init'], root);
}

function jobIdOf(stateRoot, repoKey) {
  return fs.readdirSync(path.join(stateRoot, 'jobs', repoKey))[0];
}

function worktrees(repoRoot) {
  return git(['worktree', 'list', '--porcelain'], repoRoot)
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => path.resolve(line.slice('worktree '.length)));
}

function adapter() {
  return new FakeAdapter({
    capabilities: { schema_version: 1, backend: 'fake', core: { submit: true }, extensions: {} },
  });
}

async function runCase(mode, failure) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-submit-spawn-failure-'));
  const repoRoot = path.join(root, 'repo');
  const stateRoot = path.join(root, 'state');
  const repoKey = 'spawn-failure';
  createRepo(repoRoot);
  spawnMode = failure;
  const store = new JobStore({ stateRoot });
  let thrown = null;
  let result = null;
  try {
    try {
      result = await executeSubmit({
        store, adapter: adapter(), repoKey, repoRoot, stateRoot,
        prompt: 'background task', hardTimeoutSec: 60, mode,
      });
    } catch (err) {
      thrown = err;
    }

    const jobId = result ? result.jobId : jobIdOf(stateRoot, repoKey);
    const status = store.readStatus({ repoKey, jobId });
    assert.strictEqual(status.state, 'failed', `${failure} ${mode} submit must be terminal failed`);
    assert.strictEqual(status.failure_reason, 'worker_spawn_failed');
    if (failure === 'throw') assert.strictEqual(thrown && thrown.exitCode, 18);
    else assert.strictEqual(thrown, null);

    const jobWorktree = path.join(stateRoot, 'worktrees', jobId);
    assert.ok(!fs.existsSync(jobWorktree), `${failure} ${mode} submit must remove the worktree directory`);
    assert.deepStrictEqual(worktrees(repoRoot), [path.resolve(repoRoot)],
      `${failure} ${mode} submit must unregister the job worktree`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  await runCase('implement', 'throw');
  await runCase('implement', 'error');
  await runCase('run', 'error');
  childProcess.spawn = originalSpawn;
  console.log('All submit worker-spawn failure tests passed.');
}

main().catch(err => {
  childProcess.spawn = originalSpawn;
  console.error('FAIL:', err.stack || err.message);
  process.exit(1);
});
