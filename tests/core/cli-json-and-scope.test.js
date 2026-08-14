// @suite full
// Two CLI-boundary defects found by a documentation audit, both of which made
// the CLI lie about what it accepts:
//
//  1. `--json` was accepted by `tail`, `debug` and `cleanup` and then ignored —
//     the call exited 0 while stdout stayed human text, so a caller that
//     parsed it got a syntax error instead of a result.
//  2. `review --staged --range <a>..<b>` was accepted and the range silently
//     won, so a caller who meant the index reviewed a commit range instead.
//     `--staged --working` was already exit 2; this pair was not.
//
// Asserts at the CLI boundary, because both live in cli/dcli.js.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { DEFAULT_TIMEOUT } = require('../run-tests');

const CLI = path.resolve(__dirname, '..', '..', 'cli', 'dcli.js');

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-json-scope-'));

function run(args) {
  return spawnSync(process.execPath, [CLI, '--backend', 'fake', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: DEFAULT_TIMEOUT,
    // The large-envelope case deliberately exceeds spawnSync's 1 MB default,
    // which would otherwise kill the child and look like a CLI failure.
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, DCLI_STATE_ROOT: stateRoot },
  });
}

function parseJson(r, label) {
  assert.strictEqual(r.status, 0, `${label} must exit 0, got ${r.status}: ${r.stderr}`);
  try {
    return JSON.parse(r.stdout);
  } catch (err) {
    throw new assert.AssertionError({
      message: `${label} --json must print parseable JSON, got: ${JSON.stringify(r.stdout.slice(0, 200))}`,
      actual: err.message,
    });
  }
}

function findWorkerLog(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findWorkerLog(full);
      if (hit) return hit;
    } else if (entry.name === 'worker.log') {
      return full;
    }
  }
  return null;
}

try {
  // =========================================================================
  // 1. Conflicting review scopes are a usage error, not a silent override
  // =========================================================================
  {
    const r = run(['review', '--staged', '--range', 'main..HEAD', '--hard-timeout-sec', '60']);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.strictEqual(r.status, 2, `--staged with --range must exit 2, got ${r.status}: ${out}`);
    assert.ok(/--staged/.test(out) && /--range/.test(out),
      `the error must name both flags, got: ${out}`);
    console.log('PASS: review --staged --range is exit 2, not a silent range win');
  }

  // =========================================================================
  // 2. --json is honoured by cleanup / tail / debug
  // =========================================================================
  {
    const env = parseJson(run(['cleanup', '--json', '--dry-run']), 'cleanup');
    assert.strictEqual(env.schema_version, 1, 'cleanup --json carries schema_version');
    assert.strictEqual(env.dry_run, true, 'cleanup --json reports the dry run');
    assert.ok(Array.isArray(env.worktrees), 'cleanup --json lists worktrees');
    console.log('PASS: cleanup --json emits a JSON envelope');
  }

  {
    const submitted = run(['submit', '--hard-timeout-sec', '60', '--group', 'json-probe', 'probe']);
    assert.strictEqual(submitted.status, 0, `submit must exit 0: ${submitted.stderr}`);
    const jobId = submitted.stdout.trim();

    // submit only proves the worker launched. Everything below reads and then
    // grows this job's log and finally deletes the whole state root, so the
    // detached worker has to be finished with it first.
    const waited = run(['wait', jobId, '--timeout-sec', '90']);
    assert.strictEqual(waited.status, 0,
      `the probe job must reach a terminal state before its log is touched, got ${waited.status}: ${waited.stderr}`);

    const tail = parseJson(run(['tail', jobId, '--json']), 'tail');
    assert.strictEqual(tail.schema_version, 1, 'tail --json carries schema_version');
    assert.strictEqual(tail.job_id, jobId, 'tail --json names the job');
    assert.ok('worker' in tail && 'backend_events' in tail,
      'tail --json reports both log slots, null when absent');
    console.log('PASS: tail --json emits a JSON envelope');

    const debug = parseJson(run(['debug', jobId, '--json']), 'debug');
    assert.strictEqual(debug.schema_version, 1, 'debug --json carries schema_version');
    assert.strictEqual(debug.job_id, jobId, 'debug --json names the job');
    console.log('PASS: debug --json emits a JSON envelope');

    // A large envelope through a pipe. Node writes to a pipe synchronously on
    // Windows and Linux, so this cannot reproduce the exit-before-flush
    // truncation that macOS (async pipe writes) would show — printJson's
    // fs.writeSync is the guard for that, and this case only proves a
    // multi-megabyte envelope arrives whole. An empty state root proves
    // neither.
    const workerLog = findWorkerLog(stateRoot);
    assert.ok(workerLog, 'the submitted job must have a worker.log to grow');
    fs.appendFileSync(workerLog, 'x'.repeat(4 * 1024 * 1024));
    const big = parseJson(run(['tail', jobId, '--json', '--max-bytes', '4194304']), 'tail (large)');
    assert.ok(big.worker.returnedBytes > 1024 * 1024,
      `the large case must actually be large, got ${big.worker.returnedBytes} bytes`);
    console.log('PASS: a multi-megabyte --json envelope survives the pipe intact');
  }

  console.log('\nAll CLI --json and review-scope tests passed.');
} finally {
  try { fs.rmSync(stateRoot, { recursive: true, force: true }); } catch { /* best effort */ }
}
