// Ticket 95 criterion D: five setup-failure cases, each asserted once against
// openAttempt (not three times through three commands). In every case the
// ownership boundary inside core/job-setup.js must leave no worktree directory
// and no held admission slot behind, and must preserve the original error.
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { JobStore } = require('../../core/job-store');
const { AdmissionController } = require('../../core/admission');
const { FakeAdapter } = require('../../adapters/fake/adapter');
const { openAttempt } = require('../../core/job-setup');
const { DEFAULT_TIMEOUT } = require('../run-tests');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-setup-failure-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return fn(dir).then(cleanup, (err) => { cleanup(); throw err; });
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: DEFAULT_TIMEOUT });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function createRepo(root) {
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  git(['init', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 't@t.com'], repoRoot);
  git(['config', 'user.name', 'T'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# x\n', 'utf8');
  git(['add', '-A'], repoRoot);
  git(['commit', '-m', 'init'], repoRoot);
  return repoRoot;
}

function gitWorktrees(repoRoot) {
  return git(['worktree', 'list', '--porcelain'], repoRoot)
    .split(/\r?\n/)
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length));
}

function slotFiles(stateRoot) {
  const slotDir = path.join(stateRoot, 'locks', 'admission');
  if (!fs.existsSync(slotDir)) return [];
  return fs.readdirSync(slotDir).filter(f => f.endsWith('.json'));
}

function worktreeDirs(stateRoot) {
  const dir = path.join(stateRoot, 'worktrees');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir);
}

function setupError(message) {
  const err = new Error(message);
  err.exitCode = 17;
  return err;
}

function storeWithFailure(store, method, err) {
  store[method] = () => { throw err; };
  return store;
}

function countingAdmission(stateRoot, overrides) {
  const controller = new AdmissionController({ stateRoot, ...(overrides || {}) });
  const spy = { acquireCalls: 0, releaseCalls: 0 };
  const origAcquire = controller.acquireSlot.bind(controller);
  const origRelease = controller.releaseSlot.bind(controller);
  controller.acquireSlot = (...args) => { spy.acquireCalls++; return origAcquire(...args); };
  controller.releaseSlot = (...args) => { spy.releaseCalls++; return origRelease(...args); };
  return { controller, spy };
}

function makeAdapter() {
  return new FakeAdapter({
    facts: [{ type: 'process_exited', code: 0 }],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });
}

function openImplementAttempt({ store, repoRoot, stateRoot, admission }) {
  return openAttempt({
    store,
    adapter: makeAdapter(),
    request: { model: null, canonicalDir: repoRoot, variant: null, effort: null, access: 'read-only' },
    prompt: 'implement something',
    repoKey: 'setup-fail', repoRoot,
    mode: 'implement', access: 'read-only',
    group: null, label: null, model: null,
    hardTimeoutSec: 60, stateRoot,
    lineage: null,
    admission,
  });
}

// Each row names the failing setup step; openAttempt must release every
// resource acquired before that step and rethrow the original error.
const CASES = [
  {
    name: 'admission full',
    // A backend limit of 0 makes acquireSlot refuse before the worktree step
    // even starts; the created worktree must still be removed.
    setup: ({ stateRoot }) => countingAdmission(stateRoot, { backendLimits: { fake: 0 } }),
    expect: { exitCode: 17, failureClass: 'lock', acquire: 1, release: 0 },
  },
  {
    name: 'createJob throws',
    setup: ({ store }) => { storeWithFailure(store, 'createJob', setupError('injected createJob failure')); },
    expect: { exitCode: 17, message: 'injected createJob failure', acquire: 1, release: 1 },
  },
  {
    name: 'createAttemptDir throws',
    setup: ({ store }) => { storeWithFailure(store, 'createAttemptDir', setupError('injected createAttemptDir failure')); },
    expect: { exitCode: 17, message: 'injected createAttemptDir failure', acquire: 1, release: 1 },
  },
  {
    name: 'persistInitFiles throws',
    // persistInitFiles is a module function, not a store method; failing
    // store.getJobDir — its first store call — throws from inside that call.
    setup: ({ store }) => { storeWithFailure(store, 'getJobDir', setupError('injected persistInitFiles failure')); },
    expect: { exitCode: 17, message: 'injected persistInitFiles failure', acquire: 1, release: 1 },
  },
];

async function main() {
  for (const c of CASES) {
    await withTempDir(async (dir) => {
      const repoRoot = createRepo(dir);
      const stateRoot = path.join(dir, 'state');
      const store = new JobStore({ stateRoot });
      const { controller, spy } = c.setup({ store, stateRoot }) || countingAdmission(stateRoot);

      let error;
      try {
        await openImplementAttempt({ store, repoRoot, stateRoot, admission: controller });
      } catch (err) { error = err; }

      assert.ok(error, `${c.name}: setup must throw`);
      assert.strictEqual(error.exitCode, c.expect.exitCode, `${c.name}: original exit code must be preserved`);
      if (c.expect.failureClass) {
        assert.strictEqual(error.failureClass, c.expect.failureClass,
          `${c.name}: capacity failure must carry failureClass ${c.expect.failureClass}`);
      }
      if (c.expect.message) assert.strictEqual(error.message, c.expect.message, `${c.name}: original error must be preserved`);
      assert.strictEqual(spy.acquireCalls, c.expect.acquire, `${c.name}: slot acquisition count`);
      assert.strictEqual(spy.releaseCalls, c.expect.release, `${c.name}: slot release count`);
      assert.strictEqual(slotFiles(stateRoot).length, 0, `${c.name}: no admission slot file may remain`);
      assert.strictEqual(worktreeDirs(stateRoot).length, 0, `${c.name}: no worktree directory may remain`);
      assert.strictEqual(gitWorktrees(repoRoot).length, 1, `${c.name}: only the main repo worktree registration may remain`);
      console.log(`PASS: setup failure — ${c.name}`);
    });
  }

  // =========================================================================
  // worktree already exists at the exact path openAttempt will use. The
  // failure happens before ANY resource was acquired, and the guard must not
  // delete a directory setup never created (ticket 90).
  // =========================================================================
  await withTempDir(async (dir) => {
    const repoRoot = createRepo(dir);
    const stateRoot = path.join(dir, 'state');
    const store = new JobStore({ stateRoot });
    const { controller, spy } = countingAdmission(stateRoot);

    const origRandomInt = crypto.randomInt;
    let error = null;
    let collidedPath = null;
    try {
      // Deterministic jobId suffix; the timestamp prefix is read from the same
      // clock openAttempt uses, retried across a second boundary if one rolls.
      crypto.randomInt = () => 0;
      for (let i = 0; i < 3 && !error; i++) {
        const ts = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        const prePath = path.join(stateRoot, 'worktrees', `${ts}-aaaaaaaa`);
        fs.mkdirSync(prePath, { recursive: true });
        try {
          await openImplementAttempt({ store, repoRoot, stateRoot, admission: controller });
        } catch (err) {
          error = err;
          if (err.message.includes(prePath)) collidedPath = prePath;
        }
      }
    } finally {
      crypto.randomInt = origRandomInt;
    }

    assert.ok(error, 'a pre-existing worktree path must fail setup');
    assert.strictEqual(error.exitCode, 23, 'worktree preparation failure must keep exit 23');
    assert.ok(/already exists/.test(error.message), `expected already-exists error, got: ${error.message}`);
    assert.ok(collidedPath, 'the collision must be with the directory this test pre-created');
    assert.ok(fs.existsSync(collidedPath), 'the pre-existing directory must NOT be removed by the guard');
    assert.strictEqual(spy.acquireCalls, 0, 'worktree failure must precede slot acquisition');
    assert.strictEqual(spy.releaseCalls, 0, 'nothing may be released when nothing was acquired');
    assert.strictEqual(slotFiles(stateRoot).length, 0, 'no admission slot file may remain');
    console.log('PASS: setup failure — worktree already exists');
  });

  // =========================================================================
  // Ticket 119 criterion A — at-capacity `run --json` exits 17 and reports
  // failure_class "lock" in the JSON output, not a quota/rate-limit 14.
  // =========================================================================
  await withTempDir(async (dir) => {
    const repoRoot = createRepo(dir);
    const stateRoot = path.join(dir, 'state');
    // Fill every fake-backend admission slot from this process so the CLI's
    // own controller (same state root, fake limit 3) sees no capacity left.
    const filler = new AdmissionController({ stateRoot, backendLimits: { fake: 3 } });
    const slots = [];
    for (let i = 0; i < 3; i++) {
      const s = filler.acquireSlot('fake');
      assert.ok(s.acquired, `slot ${i + 1}/3 must be acquired by the filler`);
      slots.push(s.slotId);
    }
    try {
      const CLI = path.join(__dirname, '..', '..', 'cli', 'dcli.js');
      const r = spawnSync(process.execPath, [
        CLI, '--backend', 'fake', 'run', '--repo', repoRoot, '--json', 'say hi',
      ], {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, DCLI_STATE_ROOT: stateRoot },
        timeout: DEFAULT_TIMEOUT,
      });
      assert.strictEqual(r.status, 17, `at-capacity run --json must exit 17, got ${r.status}: ${r.stderr}`);
      const envelope = JSON.parse(r.stdout);
      assert.strictEqual(envelope.failure_class, 'lock', '--json output must carry failure_class "lock"');
      assert.ok(/Try again later/.test(envelope.detail), `message must keep the retry advice: ${envelope.detail}`);
      assert.strictEqual(slotFiles(stateRoot).length, 3, 'the CLI must not create or steal any slot');
      console.log('PASS: setup failure — at-capacity run --json exits 17 with failure_class "lock"');
    } finally {
      for (const id of slots) filler.releaseSlot(id);
    }
  });

  // =======================================================================
  // State-root storage failure must not become 0/undefined capacity.
  // =======================================================================
  await withTempDir(async (dir) => {
    const repoRoot = createRepo(dir);
    const stateRoot = path.join(dir, 'state');
    const store = new JobStore({ stateRoot });
    const controller = new AdmissionController({ stateRoot });
    const storageError = new Error(`state root not writable: ${stateRoot}`);
    storageError.code = 'EPERM';
    controller._lockManager.tryAcquire = () => { throw storageError; };

    let error;
    try {
      await openImplementAttempt({ store, repoRoot, stateRoot, admission: controller });
    } catch (err) { error = err; }

    assert.ok(error, 'state-root storage failure must fail setup');
    assert.strictEqual(error.exitCode, 15);
    assert.strictEqual(error.failureClass, 'permission_or_sandbox');
    assert.strictEqual(error.reason, 'state_root_unwritable');
    assert.ok(error.message.includes(stateRoot));
    assert.match(error.message, /DCLI_STATE_ROOT/);
    assert.doesNotMatch(error.message, /0\/undefined/);
    assert.strictEqual(slotFiles(stateRoot).length, 0);
    assert.strictEqual(worktreeDirs(stateRoot).length, 0);
    assert.strictEqual(gitWorktrees(repoRoot).length, 1);
    console.log('PASS: setup failure — state-root storage is not capacity');
  });

  console.log('\nAll setup-failure tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
