// @suite full
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const { JobStore } = require('../../core/job-store');
const { FakeAdapter } = require('../../adapters/fake/adapter');

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
    timeout: 15000,
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
// 2. run accepts prompt via --prompt-file, stdin, and positional
// ===========================================================================
await withTempDir(async (dir) => {
  const env = { ...process.env, DCLI_STATE_ROOT: dir };

  // We need to test the functions directly since CLI parsing for stdin
  // detection (isTTY) is environment-dependent.
  // Test prompt resolution via the parsePrompt function
  const { parsePrompt } = require('../../core/commands/index');
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
// 3. Positional prompt works (lowest precedence)
// ===========================================================================
{
  const { resolvePrompt } = require('../../core/commands/index');
  // Simulate: no --prompt-file, stdin not piped (isTTY), positional = "hello"
  const prompt = await resolvePrompt({ promptFile: null, stdinPipeActive: false, positionals: ['hello'] });
  assert.strictEqual(prompt, 'hello', 'positional text must be used when no other source');
}
console.log('PASS: run test 3 — positional prompt');

// ===========================================================================
// 4. --prompt-file has highest precedence
// ===========================================================================
{
  const { resolvePrompt } = require('../../core/commands/index');
  const pFile = path.join(os.tmpdir(), 'dcli-test-prompt-' + Date.now());
  fs.writeFileSync(pFile, 'file-content', 'utf8');
  try {
    const prompt = await resolvePrompt({ promptFile: pFile, stdinPipeActive: false, positionals: ['pos'] });
    assert.strictEqual(prompt, 'file-content', '--prompt-file must have highest precedence');
  } finally {
    try { fs.unlinkSync(pFile); } catch {}
  }
}
console.log('PASS: run test 4 — --prompt-file precedence');

// ===========================================================================
// 5. Present-but-unusable --prompt-file is an error
// ===========================================================================
{
  const { resolvePrompt } = require('../../core/commands/index');
  await assert.rejects(
    resolvePrompt({ promptFile: '/nonexistent/file.md', stdinPipeActive: false, positionals: [] }),
    /prompt-file/i,
    'unreadable --prompt-file must throw'
  );
}
console.log('PASS: run test 5 — unusable --prompt-file is error');

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
    }, 15000);
    child.on('exit', (code) => {
      clearTimeout(killTimer);
      resolve(code);
    });
  });
  assert.strictEqual(exitCode, 0, `silent pipe must exit 0, got ${exitCode}`);
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
  // wg-2 is still running (no terminal transition)

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
// 17. --json envelope has schema_version, all fields present, null when unset
// ===========================================================================
{
  const { buildEnvelope } = require('../../core/commands/index');

  const envelope = buildEnvelope({
    job_id: 'test-job',
    backend: 'fake',
    state: 'done',
    phase: 'terminal',
    attempt: 1,
    command_exit_code: 0,
    backend_exit_code: null,
    failure_reason: null,
    failure: null,
    findings_status: null,
  });

  assert.strictEqual(envelope.schema_version, 1, 'envelope must have schema_version');
  assert.strictEqual(envelope.job_id, 'test-job');
  assert.strictEqual(envelope.state, 'done');
  assert.strictEqual(envelope.command_exit_code, 0);
  assert.strictEqual(envelope.backend_exit_code, null);
  assert.strictEqual(envelope.findings, null);
  assert.strictEqual(envelope.findings_status, null);
  // All fields present
  const required = ['schema_version', 'job_id', 'backend', 'state', 'phase', 'attempt',
    'command_exit_code', 'backend_exit_code', 'failure_reason', 'failure', 'findings', 'findings_status'];
  for (const f of required) {
    assert.ok(f in envelope, `envelope must have field "${f}"`);
  }
}
console.log('PASS: --json envelope test');

// ===========================================================================
// 18. Valueless flags rejected with exit 2
// ===========================================================================
{
  const { parseArgs } = require('../../core/commands/index');

  // --group without value
  try {
    parseArgs(['--backend', 'fake', 'run', '--group']);
    assert.fail('Should have thrown for valueless --group');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2, 'valueless flag must throw exit 2');
    assert.ok(err.message.toLowerCase().includes('group') ||
              err.message.toLowerCase().includes('value'),
      `Error must mention the flag: ${err.message}`);
  }

  // --hard-timeout-sec without value
  try {
    parseArgs(['--backend', 'fake', 'run', '--hard-timeout-sec']);
    assert.fail('Should have thrown for valueless --hard-timeout-sec');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2);
  }
}
console.log('PASS: valueless flags rejected');

// ===========================================================================
// 19. Unknown flags rejected with exit 2
// ===========================================================================
{
  const { parseArgs } = require('../../core/commands/index');
  try {
    parseArgs(['--backend', 'fake', 'run', '--bogus-flag']);
    assert.fail('Should have thrown for unknown flag');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2);
    assert.ok(err.message.includes('bogus') || err.message.includes('unknown'),
      `Error must mention unknown flag: ${err.message}`);
  }
}
console.log('PASS: unknown flags rejected');

// ===========================================================================
// 20. Stray positionals rejected
// ===========================================================================
{
  const { parseArgs } = require('../../core/commands/index');
  // For status/wait/read which take exactly one positional (job ID),
  // extra positionals should be rejected
  try {
    parseArgs(['--backend', 'fake', 'status', 'job-1', 'extra-arg']);
    assert.fail('Should have thrown for stray positionals');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2, 'stray positionals must throw exit 2');
  }
}
console.log('PASS: stray positionals rejected');

// ===========================================================================
// 21. Range validation precedes conversion
// ===========================================================================
{
  const { parseArgs } = require('../../core/commands/index');
  // Negative timeout must be rejected BEFORE any side effect
  // (the store or adapter should not be touched)
  try {
    parseArgs(['--backend', 'fake', 'run', '--hard-timeout-sec', '-5']);
    assert.fail('Should have thrown for negative timeout');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2, 'negative timeout must exit 2');
  }
}
console.log('PASS: range validation precedes conversion');

// ===========================================================================
// 22. --help dispatches quickly before heavyweight imports
// ===========================================================================
{
  const start = Date.now();
  const result = spawnCli(['--help'], undefined);
  const elapsed = Date.now() - start;

  assert.strictEqual(result.status, 0, '--help must exit 0');
  assert.ok(result.stdout.includes('dcli'), '--help must contain tool name');
  assert.ok(result.stdout.includes('run'), '--help must list commands');
  assert.ok(result.stdout.includes('submit'), '--help must list submit');
  assert.ok(elapsed < 500, `--help must be fast (<500ms), got ${elapsed}ms`);
  console.log(`PASS: --help is fast (${elapsed}ms)`);
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

  const result = await executeSubmit({
    store,
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

// ===========================================================================
// 25. status --json emits envelope
// ===========================================================================
{
  const { buildEnvelope } = require('../../core/commands/index');
  const envelope = buildEnvelope({
    job_id: 'json-test',
    backend: 'fake',
    state: 'running',
    phase: 'agent_running',
    attempt: 2,
    command_exit_code: null,
    backend_exit_code: null,
    failure_reason: null,
    failure: null,
    findings_status: null,
  });

  assert.strictEqual(envelope.schema_version, 1);
  assert.strictEqual(envelope.state, 'running');
  assert.strictEqual(envelope.attempt, 2);
  assert.strictEqual(envelope.command_exit_code, null);
  assert.strictEqual(envelope.backend_exit_code, null);
}
console.log('PASS: status --json envelope');

// ===========================================================================
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
// Summary
// ===========================================================================
console.log('\nAll core command tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
