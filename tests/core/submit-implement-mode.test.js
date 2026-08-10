// @suite full
// Ticket 94: `submit --mode implement` must honour implement mode end to end —
// worktree prepared at submit time, worker runs inside it, snapshot finalized,
// and `diff` finds the change. Regression: the flag used to be accepted and
// silently run in `run` mode, leaving nothing to diff.
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { JobStore } = require('../../core/job-store');
const { computeRepoKeyWithPath } = require('../../core/repo-key');
const { DEFAULT_TIMEOUT } = require('../run-tests');
const { assertSpawnStatus } = require('../helpers/spawn-assert');

const CLI = path.resolve(__dirname, '../../cli/dcli.js');
const TERMINAL = ['done', 'failed', 'timed_out', 'cancelled', 'interrupted'];

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-submit-impl-'));
  const repoRoot = path.join(dir, 'repo');
  const stateRoot = path.join(dir, 'state');
  try {
    fs.mkdirSync(repoRoot, { recursive: true });
    const git = (args) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 't@t.com']);
    git(['config', 'user.name', 'T']);
    fs.writeFileSync(path.join(repoRoot, 'base.txt'), 'base\n', 'utf8');
    git(['add', '-A']);
    git(['commit', '-m', 'init']);

    // DCLI_FAKE_WRITE_FILE makes the fake backend behave like a real one in an
    // implement worktree: it writes a file into its canonical directory.
    const env = {
      ...process.env,
      DCLI_STATE_ROOT: stateRoot,
      DCLI_FAKE_WRITE_FILE: 'feature.txt',
    };

    const submit = spawnSync(process.execPath, [
      CLI, '--backend', 'fake', 'submit',
      '--mode', 'implement', '--access', 'workspace', '--repo', repoRoot,
      '--hard-timeout-sec', '60', '--group', 't94',
      'background implement from test',
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: DEFAULT_TIMEOUT,
      env,
    });
    assertSpawnStatus(submit, 0, 'submit --mode implement must exit 0', DEFAULT_TIMEOUT);

    const jobId = submit.stdout.trim();
    assert.ok(/^\d{8}T\d{6}Z-[a-z0-9]{8}$/.test(jobId), `Expected a job id, got: "${jobId}"`);

    const { repoKey } = computeRepoKeyWithPath(repoRoot);

    // The detached worker reads params.json; mode and the worktree must be in
    // it, or the worker runs in `run` mode against the main repo.
    const params = JSON.parse(
      fs.readFileSync(path.join(stateRoot, 'jobs', repoKey, jobId, 'params.json'), 'utf8'),
    );
    assert.strictEqual(params.mode, 'implement', 'params.json must record mode "implement"');
    assert.ok(params.worktreePath, 'params.json must record the worktree path');
    assert.ok(params.worktreeBaseCommit, 'params.json must record the worktree base commit');
    assert.ok(String(params.canonicalDir).includes('worktrees'), 'canonicalDir must be the worktree, not the main repo');

    // Poll store until terminal (worker runs as detached background process)
    const store = new JobStore({ stateRoot });
    const deadline = Date.now() + 60000;
    let status;
    let lastState = 'created';
    do {
      await new Promise(r => setTimeout(r, 200));
      try {
        status = store.readStatus({ repoKey, jobId });
        lastState = status.state;
      } catch {
        // Journal may be in flight
      }
    } while (!TERMINAL.includes(lastState) && Date.now() < deadline);

    assert.ok(TERMINAL.includes(lastState), `Worker did not reach terminal state within timeout. Last state: ${lastState}`);
    assert.strictEqual(lastState, 'done', `Expected 'done', got '${lastState}'`);

    assert.ok(status.worktree, 'implement-mode submit job must record worktree info');
    assert.ok(status.worktree.result_commit, 'worktree result commit must be recorded after finalize');
    assert.ok(!status.worktree.finalize_error, `finalize must succeed, got: ${status.worktree.finalize_error || 'none'}`);

    // diff must show the change the backend wrote into the worktree
    const diff = spawnSync(process.execPath, [
      CLI, '--backend', 'fake', 'diff', jobId, '--name-only', '--repo', repoRoot,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: DEFAULT_TIMEOUT,
      env: { ...process.env, DCLI_STATE_ROOT: stateRoot },
    });
    assertSpawnStatus(diff, 0, 'diff must exit 0', DEFAULT_TIMEOUT);
    assert.ok(diff.stdout.includes('feature.txt'), `diff must show feature.txt, got: "${diff.stdout.trim()}"`);

    console.log('PASS: submit --mode implement runs in implement mode and diff shows the change');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  console.log('All submit implement-mode tests passed.');
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
