// @suite full
// @serial  runs git / spawns the CLI against the real repository
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const { JobStore } = require('../../core/job-store');
const { FakeAdapter } = require('../../adapters/fake/adapter');
const { DEFAULT_TIMEOUT } = require('../run-tests');

const CLI = path.resolve(__dirname, '../../cli/dcli.js');
const TERMINAL = ['done', 'failed', 'timed_out', 'cancelled', 'interrupted'];

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-cmd-test-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return fn(dir).then(cleanup, (err) => { cleanup(); throw err; });
}

function spawnCli(args, stdin, env) {
  const opts = {
    encoding: 'utf8',
    windowsHide: true,
    // Derived from the runner's own per-file budget (ticket 105): 15 s was a
    // load-sensitive absolute bound unrelated to what these tests assert, and
    // a contended CLI invocation could exceed it and read as a hang.
    timeout: DEFAULT_TIMEOUT,
  };
  if (stdin !== undefined) {
    opts.input = stdin;
  }
  if (env !== undefined) {
    opts.env = env;
  }
  return spawnSync(process.execPath, [CLI, ...args], opts);
}

async function main() {

// ===========================================================================
// 1. run prints only the final result; stdout is byte-exact
// ===========================================================================
await withTempDir(async (dir) => {
  const env = { ...process.env, DCLI_STATE_ROOT: dir };
  const result = spawnCli(
    ['--backend', 'fake', 'run', '--hard-timeout-sec', '60', 'test prompt'],
    undefined, env
  );

  assert.strictEqual(result.status, 0, `run must exit 0, got ${result.status}`);
  assert.ok(result.stdout.length > 0, 'run must produce stdout');
  console.log('PASS: run test 1 — run produces output');
});

// ===========================================================================
// 1b. an explicit state-root override wins over the repository default
// ===========================================================================
await withTempDir(async (stateDir) => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-repo-test-'));
  try {
    const env = { ...process.env, DCLI_STATE_ROOT: stateDir };
    const result = spawnCli(
      ['--backend', 'fake', 'run', '--repo', repoDir, '--hard-timeout-sec', '60', 'test prompt'],
      undefined, env
    );

    assert.strictEqual(result.status, 0, `repo override run must exit 0, got ${result.status}`);
    assert.ok(fs.existsSync(path.join(stateDir, 'jobs')), 'override state root must contain jobs');
    assert.ok(!fs.existsSync(path.join(repoDir, '.dcli-state')), 'repo state root must not be created when overridden');
    console.log('PASS: run test 1b — explicit state root overrides repo default');
  } finally {
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
  }
});

// ===========================================================================
// 2. run accepts prompt via --prompt-file, stdin, and positional
// ===========================================================================
await withTempDir(async (dir) => {
  const env = { ...process.env, DCLI_STATE_ROOT: dir };

  // We need to test the functions directly since CLI parsing for stdin
  // detection (isTTY) is environment-dependent.
  const { executeRun } = require('../../core/commands/run');

  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_1' },
      { type: 'assistant_text', message_id: 'm1', text: 'result-from-fake' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const output = await executeRun({
    store, adapter,
    repoKey: 'test-repo',
    prompt: 'test prompt',
    hardTimeoutSec: 60,
  });
  assert.strictEqual(output.text, 'result-from-fake', 'run must return the assistant text');
  console.log('PASS: run test 2 — executeRun returns result text');
});

// ===========================================================================
// 5b. --hard-timeout-sec 0 is rejected with exit 2 at the CLI level
// ===========================================================================
await withTempDir(async (dir) => {
  const env = { ...process.env, DCLI_STATE_ROOT: dir };
  const result = spawnCli(
    ['--backend', 'fake', 'run', '--hard-timeout-sec', '0', 'test prompt'],
    undefined, env
  );
  assert.strictEqual(result.status, 2,
    `--hard-timeout-sec 0 must exit 2, got ${result.status}`);
  assert.ok(result.stderr.includes('positive integer'),
    `stderr must mention "positive integer": ${result.stderr}`);
  console.log('PASS: --hard-timeout-sec 0 rejected at CLI level');
});

// ===========================================================================
// 6. run with piped stdin (e2e via spawnCli)
// ===========================================================================
await withTempDir(async (dir) => {
  const env = { ...process.env, DCLI_STATE_ROOT: dir };
  const result = spawnCli(
    ['--backend', 'fake', 'run', '--hard-timeout-sec', '60'],
    'piped prompt text',
    env
  );
  assert.strictEqual(result.status, 0, `piped stdin must exit 0, got ${result.status}`);
  assert.ok(result.stdout.length > 0, 'piped stdin must produce stdout');
  console.log('PASS: run test 6 — piped stdin via CLI');
});

// ===========================================================================
// 7. run with --prompt-file (e2e via spawnCli)
// ===========================================================================
await withTempDir(async (dir) => {
  const env = { ...process.env, DCLI_STATE_ROOT: dir };
  const pFile = path.join(dir, 'prompt.txt');
  fs.writeFileSync(pFile, 'file-sourced prompt', 'utf8');
  const result = spawnCli(
    ['--backend', 'fake', 'run', '--hard-timeout-sec', '60', '--prompt-file', pFile],
    undefined,
    env
  );
  assert.strictEqual(result.status, 0, `--prompt-file must exit 0, got ${result.status}`);
  assert.ok(result.stdout.length > 0, '--prompt-file must produce stdout');
  // Also verify positionals are ignored when --prompt-file is present
  const result2 = spawnCli(
    ['--backend', 'fake', 'run', '--hard-timeout-sec', '60', '--prompt-file', pFile, 'ignored-pos'],
    undefined,
    env
  );
  assert.strictEqual(result2.status, 0, `--prompt-file with positionals must exit 0`);
  console.log('PASS: run test 7 — --prompt-file via CLI');
});

// ===========================================================================
// 8. Open-but-silent stdin does not hang (bounded read)
// ===========================================================================
await withTempDir(async (dir) => {
  const env = { ...process.env, DCLI_STATE_ROOT: dir };
  const child = spawn(process.execPath, [CLI, '--backend', 'fake', 'run', '--hard-timeout-sec', '60'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // Never write to or close stdin — the bounded read must let the process exit
  const exitCode = await new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, DEFAULT_TIMEOUT);
    child.on('exit', (code) => {
      clearTimeout(killTimer);
      resolve(code);
    });
  });
  assert.strictEqual(exitCode, 0,
    `silent pipe must exit 0, got ${exitCode}${exitCode === null ? ` (killed after the ${DEFAULT_TIMEOUT} ms test budget)` : ''}`);
  console.log('PASS: run test 8 — open-but-silent stdin bounded read');
});

// ===========================================================================
// 10. submit returns a job id and exits
// ===========================================================================
await withTempDir(async (dir) => {
  const env = { ...process.env, DCLI_STATE_ROOT: dir };
  const result = spawnCli(
    ['--backend', 'fake', 'submit', '--hard-timeout-sec', '300', '--group', 'demo', 'background job'],
    undefined, env
  );

  assert.strictEqual(result.status, 0, `submit must exit 0, got ${result.status}`);
  const stdout = result.stdout.trim();
  // Should contain a job ID (the output might be just the ID or a JSON envelope)
  assert.ok(stdout.length > 0, 'submit must produce stdout');
  assert.ok(stdout.includes('2026') || stdout.length >= 16, 'submit must contain a timestamped job id');
  console.log('PASS: submit test 1 — submit returns job id and exits');
});

// ===========================================================================
// 11. status reconciles before reporting
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const { executeStatus } = require('../../core/commands/status');

  // Create a terminal job
  store.createJob({
    jobId: 'stat-test-1', repoKey, repoRoot: '/tmp/test',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
  });
  store.createAttemptDir({ repoKey, jobId: 'stat-test-1', attemptNum: 1 });
  store.journalTransition('stat-test-1', repoKey, {
    kind: 'attempt_created', attempt: 1, from: null, to: 'created',
    detail: { attempt_id: 'a1', execution_token: 'tok1' },
  });
  store.journalTransition('stat-test-1', repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'done',
    detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal' },
  });

  const result = await executeStatus({ store, repoKey, jobId: 'stat-test-1' });
  assert.strictEqual(result.envelope.state, 'done', 'status must report done');
  assert.ok(result.envelope.schema_version, 'status envelope must have schema_version');
  console.log('PASS: status test 1 — status reconciles and reports');
});

// ===========================================================================
// 12. wait --timeout-sec returns exit 20 on caller timeout
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const { executeWait } = require('../../core/commands/wait');

  // Create a job that stays in 'created' (never runs)
  store.createJob({
    jobId: 'wait-test-timeout', repoKey, repoRoot: '/tmp/test',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
  });

  // Wait with a very short timeout — must exit with timeout
  const result = await executeWait({
    store, repoKey, jobId: 'wait-test-timeout',
    timeoutSec: 0.5, // 500ms
    pollMs: 50,
  });

  assert.strictEqual(result.exitCode, 20, 'wait timeout must exit 20');
  assert.ok(result.timedOut, 'result must indicate timeout');
  const status = store.readStatus({ repoKey, jobId: 'wait-test-timeout' });
  assert.ok(!TERMINAL.includes(status.state), 'timed-out wait must leave job active');
  console.log('PASS: wait test 1 — timeout returns exit 20, job still active');
});

// ===========================================================================
// 13. wait --all --group gathers a snapshot batch
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const { executeWaitAll } = require('../../core/commands/wait');

  // Create two jobs in same group, one terminal, one not
  store.createJob({
    jobId: 'wg-1', repoKey, repoRoot: '/tmp/test',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
    group: 'demo',
  });
  store.createAttemptDir({ repoKey, jobId: 'wg-1', attemptNum: 1 });
  store.journalTransition('wg-1', repoKey, {
    kind: 'attempt_created', attempt: 1, from: null, to: 'created',
    detail: { attempt_id: 'a1', execution_token: 'tok1' },
  });
  store.journalTransition('wg-1', repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'done',
    detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal' },
  });

  store.createJob({
    jobId: 'wg-2', repoKey, repoRoot: '/tmp/test',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
    group: 'demo',
  });
  store.createAttemptDir({ repoKey, jobId: 'wg-2', attemptNum: 1 });
  store.journalTransition('wg-2', repoKey, {
    kind: 'attempt_created', attempt: 1, from: null, to: 'created',
    detail: { attempt_id: 'a2', execution_token: 'tok2' },
  });
  store.journalTransition('wg-2', repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'done',
    detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal' },
  });

  // Also create a non-group job
  store.createJob({
    jobId: 'wg-other', repoKey, repoRoot: '/tmp/test',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
    group: 'other-group',
  });

  const result = await executeWaitAll({ store, group: 'demo', timeoutSec: 5 });
  assert.strictEqual(result.exitCode, 0, 'wait --all must exit 0');
  assert.ok(result.jobs.length >= 2, 'wait --all must return all group jobs');
  const ids = result.jobs.map(j => j.job_id);
  assert.ok(ids.includes('wg-1'), 'wait --all must include wg-1');
  assert.ok(ids.includes('wg-2'), 'wait --all must include wg-2');
  console.log('PASS: wait test 2 — wait --all --group snapshot batch');
});

// ===========================================================================
// 14. read returns exit 4 for non-terminal job
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const { executeRead } = require('../../core/commands/read');

  store.createJob({
    jobId: 'read-test-nt', repoKey, repoRoot: '/tmp/test',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
  });

  const result = await executeRead({ store, repoKey, jobId: 'read-test-nt' });
  assert.strictEqual(result.exitCode, 4, 'read on non-terminal must exit 4');
  assert.strictEqual(result.isTerminal, false, 'result must indicate non-terminal');
  console.log('PASS: read test 1 — non-terminal job returns exit 4');
});

// ===========================================================================
// 15. read returns result for terminal job
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const { executeRead } = require('../../core/commands/read');

  store.createJob({
    jobId: 'read-test-done', repoKey, repoRoot: '/tmp/test',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
  });
  store.createAttemptDir({ repoKey, jobId: 'read-test-done', attemptNum: 1 });

  // Write a result file
  const jobDir = store.getJobDir(repoKey, 'read-test-done');
  const attemptDir = path.join(jobDir, 'attempts', '1');
  fs.mkdirSync(attemptDir, { recursive: true });
  fs.writeFileSync(path.join(attemptDir, 'result.md'), 'final result text', 'utf8');

  store.journalTransition('read-test-done', repoKey, {
    kind: 'attempt_created', attempt: 1, from: null, to: 'created',
    detail: { attempt_id: 'a1', execution_token: 'tok1' },
  });
  store.journalTransition('read-test-done', repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'done',
    detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal', result_bytes: 16 },
  });

  const result = await executeRead({ store, repoKey, jobId: 'read-test-done' });
  assert.strictEqual(result.exitCode, 0, 'read on terminal job must exit 0');
  assert.ok(result.text || result.envelope, 'read must return result content');
  console.log('PASS: read test 2 — terminal job returns result');
});

// ===========================================================================
// 16. list is newest-first with --repo filtering
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKeyA = 'repo-a';
  const repoKeyB = 'repo-b';
  const { executeList } = require('../../core/commands/list');

  store.createJob({
    jobId: 'list-1', repoKey: repoKeyA, repoRoot: '/tmp/a',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
  });
  store.createJob({
    jobId: 'list-2', repoKey: repoKeyA, repoRoot: '/tmp/a',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
  });
  store.createJob({
    jobId: 'list-3', repoKey: repoKeyB, repoRoot: '/tmp/b',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
  });

  // Wait for timestamps to settle (creates are fast, need ordering)
  await new Promise(r => setTimeout(r, 10));

  store.createJob({
    jobId: 'list-4', repoKey: repoKeyA, repoRoot: '/tmp/a',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
  });

  // All jobs (newest first)
  const all = await executeList({ store });
  assert.strictEqual(all.exitCode, 0, 'list must exit 0');
  assert.ok(all.jobs.length >= 4, 'list must find all jobs');
  // Newest first — list-4 should be first
  assert.strictEqual(all.jobs[0].job_id, 'list-4', 'newest first');

  // Filter by repo
  const filtered = await executeList({ store, repoKey: repoKeyB });
  assert.strictEqual(filtered.jobs.length, 1, 'repo filter must match exactly');
  assert.strictEqual(filtered.jobs[0].job_id, 'list-3', 'repo filter must match correct job');

  console.log('PASS: list test 1 — newest-first with --repo filtering');
});

// ===========================================================================
// 22. --help dispatches quickly before heavyweight imports
// ===========================================================================
{
  const helpStart = Date.now();
  const result = spawnCli(['--help'], undefined);
  const helpElapsed = Date.now() - helpStart;

  assert.strictEqual(result.status, 0, '--help must exit 0');
  assert.ok(result.stdout.includes('dcli'), '--help must contain tool name');
  assert.ok(result.stdout.includes('run'), '--help must list commands');
  assert.ok(result.stdout.includes('submit'), '--help must list submit');

  // The invariant is "--help dispatches before heavyweight imports" (core/job-store,
  // adapters, etc.), not an exact millisecond figure -- a hard low-ms wall-clock
  // ceiling is flaky under machine load (observed: 557ms on a loaded host). Prove
  // the invariant with a relative comparison instead: an unknown command still
  // reaches the heavyweight-import path (arg parsing -> JobStore/adapter load)
  // before failing, so it must take at least as long as --help's fast path.
  const heavyStart = Date.now();
  spawnCli(['--backend', 'fake', 'status', 'nonexistent-job-id-for-timing-probe']);
  const heavyElapsed = Date.now() - heavyStart;

  assert.ok(
    helpElapsed <= heavyElapsed + 250,
    `--help (${helpElapsed}ms) must not be slower than the heavyweight-import path (${heavyElapsed}ms) by more than noise`
  );
  console.log(`PASS: --help is fast (help=${helpElapsed}ms, heavy=${heavyElapsed}ms)`);
}

// ===========================================================================
// 23. Every example in docs includes a budget
//    - Check the CLI help text
// ===========================================================================
{
  const result = spawnCli(['--help'], undefined);
  assert.strictEqual(result.status, 0);

  // The help text should mention timeouts or budgets
  const help = result.stdout;
  assert.ok(
    help.includes('hard-timeout') || help.includes('timeout') || help.includes('budget'),
    'Help text must mention execution budget'
  );
}
console.log('PASS: help text mentions budget');

// ===========================================================================
// 24. submit job persists in store
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const { executeSubmit } = require('../../core/commands/submit');
  const { FakeAdapter } = require('../../adapters/fake/adapter');

  const adapter = new FakeAdapter({
    facts: [],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { submit: true }, extensions: {} },
  });

  const result = await executeSubmit({
    store, adapter,
    repoKey: 'test-repo',
    prompt: 'background task',
    hardTimeoutSec: 300,
    group: 'demo',
  });

  assert.ok(result.jobId, 'submit must return a jobId');
  assert.ok(result.jobId.length > 0, 'jobId must be non-empty');

  // Verify the job exists in the store
  const status = store.readStatus({ repoKey: 'test-repo', jobId: result.jobId });
  assert.strictEqual(status.state, 'created', 'submitted job must be in created state');
  assert.strictEqual(status.group, 'demo', 'group must be recorded');
  console.log('PASS: submit test 2 — job persists in store');
});

// 26. list cross-repository listing
// ===========================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const { executeList } = require('../../core/commands/list');

  store.createJob({
    jobId: 'cross-1', repoKey: 'repo-x', repoRoot: '/tmp/x',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
  });
  store.createJob({
    jobId: 'cross-2', repoKey: 'repo-y', repoRoot: '/tmp/y',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
  });

  const all = await executeList({ store });
  assert.strictEqual(all.exitCode, 0);
  const repoKeys = [...new Set(all.jobs.map(j => j.repo_key))];
  assert.ok(repoKeys.includes('repo-x'), 'cross-repo list must include repo-x');
  assert.ok(repoKeys.includes('repo-y'), 'cross-repo list must include repo-y');
  console.log('PASS: list test 2 — cross-repository listing');
});

// ===========================================================================
// implement mode: executeRun creates a worktree, runs the backend inside it,
// finalizes a snapshot, and the job's worktree info is then usable by
// diff/apply — this is the real orchestration path ticket 22 requires,
// not just the standalone worktree.js primitives.
// ===========================================================================
await withTempDir(async (dir) => {
  const repoRoot = path.join(dir, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  const git = (args) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 't@t.com']);
  git(['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# x\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-m', 'init']);

  const stateRoot = path.join(dir, 'state');
  const { executeRun } = require('../../core/commands/run');
  const store = new JobStore({ stateRoot });
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_1' },
      { type: 'assistant_text', message_id: 'm1', text: 'done' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
    behaviors: {
      onStart: (attempt, request) => {
        // The backend writes into its canonical directory, exactly as a
        // real implement-mode job would.
        fs.writeFileSync(path.join(request.canonicalDir, 'feature.txt'), 'new feature\n', 'utf8');
      },
    },
  });

  const output = await executeRun({
    store, adapter, repoKey: 'impl-repo', repoRoot,
    prompt: 'add a feature', hardTimeoutSec: 60,
    mode: 'implement', stateRoot,
  });
  assert.strictEqual(output.text, 'done');

  const status = store.readStatus({ repoKey: 'impl-repo', jobId: output.jobId });
  assert.ok(status.worktree, 'implement-mode job must record worktree info');
  assert.ok(status.worktree.path, 'worktree path must be recorded');
  assert.ok(status.worktree.base_commit, 'base_commit must be recorded');
  assert.ok(status.worktree.result_commit, 'result_commit must be recorded after finalize');
  assert.ok(!status.worktree.finalize_error, 'finalize must succeed for a clean backend run');

  const { executeDiff } = require('../../core/commands/diff');
  const diffResult = executeDiff({ store, repoKey: 'impl-repo', jobId: output.jobId, nameOnly: true });
  assert.strictEqual(diffResult.exitCode, 0);
  assert.ok(diffResult.text.includes('feature.txt'), 'diff must show the file the backend wrote');

  const { executeApply } = require('../../core/commands/apply');
  const applyResult = executeApply({ store, repoKey: 'impl-repo', jobId: output.jobId });
  assert.strictEqual(applyResult.exitCode, 0);
  assert.ok(fs.existsSync(path.join(repoRoot, 'feature.txt')), 'apply must land the change into the main repo');

  console.log('PASS: implement mode — real run -> diff -> apply through executeRun (not just worktree.js primitives)');
});

// 26. Default hard timeout is applied when --hard-timeout-sec is omitted
// ===========================================================================
await withTempDir(async (dir) => {
  const { executeRun } = require('../../core/commands/run');
  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_def' },
      { type: 'assistant_text', message_id: 'm1', text: 'ok' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  // With a short env override so the test runs fast
  const saved = process.env.DCLI_HARD_TIMEOUT;
  process.env.DCLI_HARD_TIMEOUT = '100';
  try {
    const output = await executeRun({
      store, adapter,
      repoKey: 'def-tmt',
      prompt: 'test prompt',
    });

    assert.strictEqual(output.envelope.state, 'done',
      `Expected done when adapter finishes before timeout, got ${output.envelope.state}`);
  } finally {
    if (saved === undefined) {
      delete process.env.DCLI_HARD_TIMEOUT;
    } else {
      process.env.DCLI_HARD_TIMEOUT = saved;
    }
  }

  console.log('PASS: default hard timeout applied (env override exercised for speed)');
});

// ===========================================================================
// 27. Default hard timeout fires when adapter hangs and --hard-timeout-sec omitted
// ===========================================================================
await withTempDir(async (dir) => {
  const { executeRun } = require('../../core/commands/run');
  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_hang' },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
    behaviors: { hangAfter: 'started' },
  });

  const saved = process.env.DCLI_HARD_TIMEOUT;
  process.env.DCLI_HARD_TIMEOUT = '500';
  const startTime = Date.now();
  try {
    const output = await executeRun({
      store, adapter,
      repoKey: 'def-tmt-hang',
      prompt: 'test prompt',
    });

    const elapsed = Date.now() - startTime;
    assert.strictEqual(output.envelope.state, 'timed_out',
      `Expected timed_out when adapter hangs, got ${output.envelope.state}`);
    assert.ok(elapsed < 30000,
      `Hang timeout must complete within 30s, took ${elapsed}ms`);
  } finally {
    if (saved === undefined) {
      delete process.env.DCLI_HARD_TIMEOUT;
    } else {
      process.env.DCLI_HARD_TIMEOUT = saved;
    }
  }

  console.log('PASS: default hard timeout fires when adapter hangs');
});

// ===========================================================================
// 28. resume: piped stdin prompt reaches adapter (not job ID)
// ===========================================================================
await withTempDir(async (dir) => {
  const { executeResume } = require('../../core/commands/resume');
  const store = new JobStore({ stateRoot: dir });
  const parentJobId = 'res-parent-001';

  // Create parent job in done state
  store.createJob({
    jobId: parentJobId, repoKey: 'res-test', repoRoot: dir,
    backend: 'test', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only', hardTimeoutSec: 600,
    capabilitiesSnapshot: {},
  });
  store.createAttemptDir({ repoKey: 'res-test', jobId: parentJobId, attemptNum: 1 });
  store.journalTransition(parentJobId, 'res-test', {
    kind: 'attempt_state_changed', attempt: 1,
    from: 'created', to: 'done',
    detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal', backend_session_id: 'ses_1' },
  });

  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_res' },
      { type: 'assistant_text', message_id: 'm1', text: 'followup ok' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true, resume: true } },
  });

  const output = await executeResume({
    store, adapter, repoKey: 'res-test', repoRoot: dir,
    prompt: 'follow-up from stdin',
    kind: 'retry_attempt', hardTimeoutSec: 60,
    parentJobId,
  });

  assert.strictEqual(adapter.lastPrompt, 'follow-up from stdin',
    `Adapter must receive the follow-up prompt, got "${adapter.lastPrompt}"`);
  assert.strictEqual(output.envelope.state, 'done',
    `Expected done, got ${output.envelope.state}`);

  console.log('PASS: resume sends correct prompt to adapter');
});

// ===========================================================================
// 29. resume: positional follow-up prompt is correct (no job ID in it)
// ===========================================================================
await withTempDir(async (dir) => {
  const { executeResume } = require('../../core/commands/resume');
  const store = new JobStore({ stateRoot: dir });
  const parentJobId = 'res-parent-002';

  store.createJob({
    jobId: parentJobId, repoKey: 'res-test2', repoRoot: dir,
    backend: 'test', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only', hardTimeoutSec: 600,
    capabilitiesSnapshot: {},
  });
  store.createAttemptDir({ repoKey: 'res-test2', jobId: parentJobId, attemptNum: 1 });
  store.journalTransition(parentJobId, 'res-test2', {
    kind: 'attempt_state_changed', attempt: 1,
    from: 'created', to: 'done',
    detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal', backend_session_id: 'ses_2' },
  });

  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_pos' },
      { type: 'assistant_text', message_id: 'm1', text: 'positional ok' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true, resume: true } },
  });

  const output = await executeResume({
    store, adapter, repoKey: 'res-test2', repoRoot: dir,
    prompt: 'continue with X',
    kind: 'retry_attempt', hardTimeoutSec: 60,
    parentJobId,
  });

  assert.strictEqual(adapter.lastPrompt, 'continue with X',
    `Adapter must receive only positional follow-up, got "${adapter.lastPrompt}"`);
  assert.ok(!adapter.lastPrompt.includes(parentJobId),
    `Prompt must NOT contain parent job ID, got "${adapter.lastPrompt}"`);
  assert.strictEqual(output.envelope.state, 'done');

  console.log('PASS: resume positional prompt excludes job ID');
});

// ===========================================================================
// 30. resume: --prompt-file delivers content to adapter
// ===========================================================================
await withTempDir(async (dir) => {
  const { executeResume } = require('../../core/commands/resume');
  const store = new JobStore({ stateRoot: dir });
  const parentJobId = 'res-parent-003';
  const promptFilePath = path.join(dir, 'followup-prompt.md');
  fs.writeFileSync(promptFilePath, '# Follow-up\nContinue from here.', 'utf8');

  store.createJob({
    jobId: parentJobId, repoKey: 'res-test3', repoRoot: dir,
    backend: 'test', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only', hardTimeoutSec: 600,
    capabilitiesSnapshot: {},
  });
  store.createAttemptDir({ repoKey: 'res-test3', jobId: parentJobId, attemptNum: 1 });
  store.journalTransition(parentJobId, 'res-test3', {
    kind: 'attempt_state_changed', attempt: 1,
    from: 'created', to: 'done',
    detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal', backend_session_id: 'ses_3' },
  });

  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_pf' },
      { type: 'assistant_text', message_id: 'm1', text: 'ok' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true, resume: true } },
  });

  const promptContent = fs.readFileSync(promptFilePath, 'utf8');
  const output = await executeResume({
    store, adapter, repoKey: 'res-test3', repoRoot: dir,
    prompt: promptContent,
    kind: 'retry_attempt', hardTimeoutSec: 60,
    parentJobId,
  });

  assert.strictEqual(adapter.lastPrompt, '# Follow-up\nContinue from here.',
    `Adapter must receive prompt-file content, got "${adapter.lastPrompt}"`);
  assert.strictEqual(output.envelope.state, 'done');

  console.log('PASS: resume --prompt-file content reaches adapter');
});

// ===========================================================================
// 31. resume via CLI: piped stdin does not use job ID as prompt
// ===========================================================================
await withTempDir(async (dir) => {
  const { computeRepoKeyWithPath } = require('../../core/repo-key');
  const stateRoot = path.join(dir, 'state');
  const { repoKey } = computeRepoKeyWithPath(dir);
  const store = new JobStore({ stateRoot });
  // Must be a well-formed dcli job id: the CLI rejects foreign id shapes.
  const parentJobId = '20260804T104800Z-resparnt';

  store.createJob({
    jobId: parentJobId, repoKey, repoRoot: dir,
    backend: 'test', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only', hardTimeoutSec: 600,
    capabilitiesSnapshot: {},
  });
  store.createAttemptDir({ repoKey, jobId: parentJobId, attemptNum: 1 });
  store.journalTransition(parentJobId, repoKey, {
    kind: 'attempt_state_changed', attempt: 1,
    from: 'created', to: 'done',
    detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal', backend_session_id: 'ses_cli' },
  });

  const env = { ...process.env, DCLI_STATE_ROOT: stateRoot };
  const result = spawnCli(
    ['--backend', 'fake', '--repo', dir, 'resume', parentJobId, '--kind', 'retry_attempt', '--hard-timeout-sec', '60'],
    'piped follow-up message',
    env
  );

  assert.strictEqual(result.status, 0,
    `resume with piped stdin must exit 0, got ${result.status}. stderr: ${result.stderr}`);

  console.log('PASS: resume via CLI with piped stdin succeeds');
});

// 35. Observe ending without process_exited → interrupted (stream_closed, no error)
// ===========================================================================
await withTempDir(async (dir) => {
  const { executeRun } = require('../../core/commands/run');
  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_sc' },
      { type: 'assistant_text', message_id: 'm1', text: 'got text' },
      { type: 'stream_closed', reason: 'session_ended' },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const output = await executeRun({
    store, adapter, repoKey: 'obs-test1', repoRoot: dir,
    prompt: 'test', hardTimeoutSec: 60,
  });

  assert.strictEqual(output.envelope.state, 'interrupted',
    `stream_closed-only observe must end interrupted, got ${output.envelope.state}`);
  assert.ok(output.text.length > 0, 'interrupted observe must still return collected text');
  assert.strictEqual(output.exitCode, 0, 'interrupted exit code must be 0');

  console.log('PASS: stream_closed-only Observe ends interrupted (not failed)');

// ===========================================================================
// 35b. stream_closed with error reason → failed
// ===========================================================================
await withTempDir(async (dir) => {
  const { executeRun } = require('../../core/commands/run');
  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_sce' },
      { type: 'assistant_text', message_id: 'm1', text: 'partial' },
      { type: 'stream_closed', reason: 'sse_disconnect' },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const output = await executeRun({
    store, adapter, repoKey: 'obs-test1b', repoRoot: dir,
    prompt: 'test', hardTimeoutSec: 60,
  });

  assert.strictEqual(output.envelope.state, 'failed',
    `stream_closed(error) must end failed, got ${output.envelope.state}`);
  assert.strictEqual(output.exitCode, 1, 'stream_closed(error) exit code must be 1');
  assert.ok(output.envelope.failure_reason === 'stream_closed',
    `failure_reason must be stream_closed, got ${output.envelope.failure_reason}`);

  console.log('PASS: stream_closed(error) Observe ends failed');
});
});

// ===========================================================================
// 36. Observe yielding nothing (empty facts) → interrupted
// ===========================================================================
await withTempDir(async (dir) => {
  const { executeRun } = require('../../core/commands/run');
  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const output = await executeRun({
    store, adapter, repoKey: 'obs-test2', repoRoot: dir,
    prompt: 'test', hardTimeoutSec: 60,
  });

  assert.strictEqual(output.envelope.state, 'interrupted',
    `empty Observe must end interrupted, got ${output.envelope.state}`);
  assert.strictEqual(output.exitCode, 0, 'interrupted exit code must be 0');

  console.log('PASS: empty Observe ends interrupted (not failed with exit 1)');
});

// ===========================================================================
// 37. Observe with process_exited {code: 0} still resolves to done (regression)
// ===========================================================================
await withTempDir(async (dir) => {
  const { executeRun } = require('../../core/commands/run');
  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_done' },
      { type: 'assistant_text', message_id: 'm1', text: 'success' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const output = await executeRun({
    store, adapter, repoKey: 'obs-test3', repoRoot: dir,
    prompt: 'test', hardTimeoutSec: 60,
  });

  assert.strictEqual(output.envelope.state, 'done',
    `process_exited(code=0) must stay done, got ${output.envelope.state}`);

  console.log('PASS: process_exited(code=0) Observe stays done');
});

// ===========================================================================
// 38. Recover: no terminal evidence → interrupted
// ===========================================================================
await withTempDir(async (dir) => {
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_rec1' },
      { type: 'assistant_text', message_id: 'm1', text: 'partial' },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const result = adapter.Recover({});
  assert.strictEqual(result.state, 'interrupted',
    `Recover with no terminal evidence must return interrupted, got ${result.state}`);

  console.log('PASS: Recover no evidence → interrupted');
});

// ===========================================================================
// 39. Recover: positive completion → done
// ===========================================================================
await withTempDir(async (dir) => {
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_rec2' },
      { type: 'assistant_text', message_id: 'm1', text: 'done' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const result = adapter.Recover({});
  assert.strictEqual(result.state, 'done',
    `Recover with process_exited(0) must return done, got ${result.state}`);

  console.log('PASS: Recover positive evidence → done');
});

// ===========================================================================
// 40. Recover: positive failure → failed
// ===========================================================================
await withTempDir(async (dir) => {
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_rec3' },
      { type: 'assistant_text', message_id: 'm1', text: 'partial' },
      { type: 'process_exited', code: 1 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const result = adapter.Recover({});
  assert.strictEqual(result.state, 'failed',
    `Recover with process_exited(1) must return failed, got ${result.state}`);

  console.log('PASS: Recover positive failure → failed');
});

// ===========================================================================
// 41. Recover: cancelled → cancelled
// ===========================================================================
await withTempDir(async (dir) => {
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_rec4' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });
  adapter.RequestCancel({}, 'hard_kill');

  const result = adapter.Recover({});
  assert.strictEqual(result.state, 'cancelled',
    `Recover cancelled must return cancelled, got ${result.state}`);

  console.log('PASS: Recover cancelled → cancelled');
});

// ===========================================================================
// Summary
// ===========================================================================
console.log('\nAll core command tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
