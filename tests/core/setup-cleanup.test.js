// Regression tests for ticket 90: a setup exception in run/resume that
// happens after a worktree was created or an admission slot was acquired must
// release those resources before rethrowing. setup either hands both to
// runAttempt() or releases every resource it acquired.
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { JobStore } = require('../../core/job-store');
const { AdmissionController } = require('../../core/admission');
const { generateJobId } = require('../../core/job-id');
const { FakeAdapter } = require('../../adapters/fake/adapter');
const { executeRun } = require('../../core/commands/run');
const { executeResume } = require('../../core/commands/resume');
const { DEFAULT_TIMEOUT } = require('../run-tests');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-setup-cleanup-'));
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

function countingAdmission(stateRoot) {
  const controller = new AdmissionController({ stateRoot });
  const spy = { acquireCalls: 0, releaseCalls: 0 };
  const origAcquire = controller.acquireSlot.bind(controller);
  const origRelease = controller.releaseSlot.bind(controller);
  controller.acquireSlot = (...args) => { spy.acquireCalls++; return origAcquire(...args); };
  controller.releaseSlot = (...args) => { spy.releaseCalls++; return origRelease(...args); };
  return { controller, spy };
}

function adapterFor(text) {
  return new FakeAdapter({
    facts: [
      ...(text === '' ? [] : [{ type: 'assistant_text', message_id: 'm1', text }]),
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });
}

function createParentJob(store, repoKey, repoRoot) {
  const jobId = generateJobId();
  store.createJob({
    jobId, repoKey, repoRoot,
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only', hardTimeoutSec: 600,
    capabilitiesSnapshot: {},
  });
  store.createAttemptDir({ repoKey, jobId, attemptNum: 1 });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created', attempt: 1, from: null, to: 'created',
    detail: { attempt_id: 'a1', execution_token: 'tok-parent' },
  });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'done',
    detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal', backend_session_id: 'ses_parent' },
  });
  return jobId;
}

async function main() {

// =============================================================================
// 1. run, implement mode — store.createJob throws after the worktree was
//    created and the admission slot acquired. Both must be released and the
//    original error (message + exitCode) preserved.
// =============================================================================
await withTempDir(async (dir) => {
  const repoRoot = createRepo(dir);
  const stateRoot = path.join(dir, 'state');
  const store = storeWithFailure(new JobStore({ stateRoot }), 'createJob', setupError('injected createJob failure'));
  const { controller, spy } = countingAdmission(stateRoot);

  let error;
  try {
    await executeRun({
      store, adapter: adapterFor('never reached'), repoKey: 'run-createjob-fail', repoRoot,
      prompt: 'implement', hardTimeoutSec: 60, mode: 'implement', stateRoot,
      admission: controller,
    });
  } catch (err) { error = err; }

  assert.ok(error, 'setup failure must be reported to the caller');
  assert.strictEqual(error.message, 'injected createJob failure', 'original error must be preserved');
  assert.strictEqual(error.exitCode, 17, 'original exit code must be preserved');
  assert.strictEqual(spy.acquireCalls, 1, 'the slot must have been acquired');
  assert.strictEqual(spy.releaseCalls, 1, 'the acquired slot must be released exactly once');
  assert.strictEqual(slotFiles(stateRoot).length, 0, 'no admission slot file may remain');
  assert.strictEqual(worktreeDirs(stateRoot).length, 0, 'no worktree directory may remain');
  assert.strictEqual(gitWorktrees(repoRoot).length, 1, 'only the main repo worktree registration may remain');
  console.log('PASS: run createJob failure releases worktree and slot');
});

// =============================================================================
// 2. run, implement mode — prepareBackend throws (unsupported reasoningEffort)
//    before the slot is acquired. The created worktree must still be removed,
//    and no slot may ever be acquired or released.
// =============================================================================
await withTempDir(async (dir) => {
  const repoRoot = createRepo(dir);
  const stateRoot = path.join(dir, 'state');
  const store = new JobStore({ stateRoot });
  const { controller, spy } = countingAdmission(stateRoot);

  let error;
  try {
    await executeRun({
      store, adapter: adapterFor('never reached'), repoKey: 'run-prepare-fail', repoRoot,
      prompt: 'implement', hardTimeoutSec: 60, mode: 'implement', stateRoot,
      admission: controller, reasoningEffort: 'high',
    });
  } catch (err) { error = err; }

  assert.ok(error, 'prepareBackend failure must be reported to the caller');
  assert.strictEqual(error.exitCode, 2, 'validation failure must keep exit 2');
  assert.strictEqual(spy.acquireCalls, 0, 'prepareBackend failure must not reach slot acquisition');
  assert.strictEqual(spy.releaseCalls, 0, 'nothing may be released when no slot was acquired');
  assert.strictEqual(worktreeDirs(stateRoot).length, 0, 'the created worktree must be removed');
  assert.strictEqual(gitWorktrees(repoRoot).length, 1, 'no git worktree registration may remain');
  console.log('PASS: run prepareBackend failure removes the created worktree');
});

// =============================================================================
// 3. resume, implement mode — store.createAttemptDir throws after createJob
//    and the slot acquisition. Both resources must be released, the partial
//    job record stays (existing reconciliation contract).
// =============================================================================
await withTempDir(async (dir) => {
  const repoRoot = createRepo(dir);
  const stateRoot = path.join(dir, 'state');
  const store = new JobStore({ stateRoot });
  const parentJobId = createParentJob(store, 'resume-attemptdir-fail', repoRoot);
  storeWithFailure(store, 'createAttemptDir', setupError('injected createAttemptDir failure'));
  const { controller, spy } = countingAdmission(stateRoot);

  let error;
  try {
    await executeResume({
      store, adapter: adapterFor('never reached'), repoKey: 'resume-attemptdir-fail', repoRoot,
      prompt: 'resume', kind: 'fork_from_artifacts', parentJobId,
      hardTimeoutSec: 60, mode: 'implement', stateRoot, admission: controller,
    });
  } catch (err) { error = err; }

  assert.ok(error, 'setup failure must be reported to the caller');
  assert.strictEqual(error.message, 'injected createAttemptDir failure', 'original error must be preserved');
  assert.strictEqual(error.exitCode, 17, 'original exit code must be preserved');
  assert.strictEqual(spy.acquireCalls, 1, 'the slot must have been acquired');
  assert.strictEqual(spy.releaseCalls, 1, 'the acquired slot must be released exactly once');
  assert.strictEqual(slotFiles(stateRoot).length, 0, 'no admission slot file may remain');
  assert.strictEqual(worktreeDirs(stateRoot).length, 0, 'no worktree directory may remain');
  assert.strictEqual(gitWorktrees(repoRoot).length, 1, 'only the main repo worktree registration may remain');
  console.log('PASS: resume createAttemptDir failure releases worktree and slot');
});

// =============================================================================
// 4. Successful implement-mode run with admission — the slot is still released
//    exactly once by attempt finalization (ownership was handed over, not
//    double-released, by the setup guard).
// =============================================================================
await withTempDir(async (dir) => {
  const repoRoot = createRepo(dir);
  const stateRoot = path.join(dir, 'state');
  const store = new JobStore({ stateRoot });
  const { controller, spy } = countingAdmission(stateRoot);

  const output = await executeRun({
    store, adapter: adapterFor('implemented output'), repoKey: 'run-success', repoRoot,
    prompt: 'implement', hardTimeoutSec: 60, mode: 'implement', stateRoot,
    admission: controller,
  });

  assert.strictEqual(output.exitCode, 0, 'successful run must exit 0');
  assert.strictEqual(spy.acquireCalls, 1, 'success path must acquire one slot');
  assert.strictEqual(spy.releaseCalls, 1, 'success path must release the slot exactly once via attempt finalization');
  assert.strictEqual(slotFiles(stateRoot).length, 0, 'success path must leave no slot file');
  console.log('PASS: successful run releases the slot exactly once');
});

console.log('\nAll setup cleanup tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
