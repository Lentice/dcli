// @suite full
// @serial  live backend
// @timeout-ms 600000
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const OPENCODE_LIVE_SMOKE = process.env.DCLI_OPENCODE_LIVE_SMOKE;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-p2-'));
}
function clean(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
function initGitRepo(dir) {
  cp.spawnSync('git', ['init'], { cwd: dir, windowsHide: true });
  cp.spawnSync('git', ['config', 'user.email', 'test@dcli.local'], { cwd: dir, windowsHide: true });
  cp.spawnSync('git', ['config', 'user.name', 'dcli test'], { cwd: dir, windowsHide: true });
}

function dcli(args, opts = {}) {
  return cp.spawnSync(process.execPath, [
    path.resolve(__dirname, '..', '..', '..', 'cli', 'dcli-opencode.js'),
    ...args,
  ], {
    encoding: 'utf8', windowsHide: true,
    timeout: opts.timeout || 30000,
    env: opts.env ? { ...process.env, ...opts.env } : { ...process.env },
  });
}

async function main() {
  if (!OPENCODE_LIVE_SMOKE || OPENCODE_LIVE_SMOKE === '0') {
    console.log('SKIP: DCLI_OPENCODE_LIVE_SMOKE not set');
    return;
  }

  // ==========================================================================
  // P2.1 — --variant is accepted by the CLI
  // ==========================================================================
  {
    const repoDir = tmpDir();
    initGitRepo(repoDir);
    const stateRoot = tmpDir();
    const env = { DCLI_STATE_ROOT: stateRoot };
    try {
      const r = dcli(['run', '--hard-timeout-sec', '60', '--model', 'opencode-go/deepseek-v4-flash', '--variant', 'high', '--repo', repoDir, 'Reply with PONG', '--json'], { env, timeout: 90000 });
      assert.strictEqual(r.status, 0, `--variant high must succeed: ${r.stderr}`);
      console.log('PASS: P2.1 --variant high accepted by CLI and run succeeds');
    } finally {
      clean(repoDir); clean(stateRoot);
    }
  }

  // ==========================================================================
  // P2.2 — --effort is rejected by opencode adapter
  // ==========================================================================
  {
    const r = dcli(['run', '--hard-timeout-sec', '5', '--effort', 'high', 'test']);
    assert.notStrictEqual(r.status, 0, '--effort must be rejected');
    assert.ok(r.stderr.includes('not supported') || r.stderr.includes('effort'),
      `--effort rejection stderr: ${r.stderr}`);
    console.log(`PASS: P2.2 --effort rejected (exit ${r.status})`);
  }

  // ==========================================================================
  // P2.3 --effort is rejected by opencode adapter
  // ==========================================================================
  {
    const r = dcli(['run', '--hard-timeout-sec', '5', '--effort', 'high', 'test']);
    assert.notStrictEqual(r.status, 0, '--effort must be rejected');
    assert.ok(r.stderr.includes('not supported') || r.stderr.includes('effort'),
      `--effort rejection stderr: ${r.stderr}`);
    console.log(`PASS: P2.3 --effort rejected (exit ${r.status})`);
  }

  // ==========================================================================
  // P2.4 — Valueless flags rejected with exit 2 (flag followed by another flag)
  // ==========================================================================
  {
    for (const testCase of [
      { flags: ['--model', '--repo', __dirname], label: '--model' },
      { flags: ['--variant', '--repo', __dirname], label: '--variant' },
      { flags: ['--message', '--repo', __dirname], label: '--message' },
    ]) {
      const r = dcli(['run', '--hard-timeout-sec', '5', ...testCase.flags, 'test prompt']);
      assert.strictEqual(
        r.status, 2,
        `${testCase.label} without value must exit 2 (usage error). exit=${r.status}, stderr=${(r.stderr || '').slice(0, 200)}`
      );
    }
    console.log('PASS: P2.4 valueless --model, --variant, --message rejected');
  }

  // ==========================================================================
  // P2.5 — Unknown flags rejected
  // ==========================================================================
  {
    const r = dcli(['run', '--bogus-flag', 'test']);
    assert.notStrictEqual(r.status, 0, 'unknown flag must be rejected');
    assert.ok(r.stderr.includes('Unknown flag') || r.stderr.includes('bogus'),
      `unknown flag rejection: ${r.stderr}`);
    console.log('PASS: P2.5 unknown flags rejected');
  }

  // ==========================================================================
  // P3.1 — Review with --staged on an empty repo completes without crash
  // ==========================================================================
  {
    const repoDir = tmpDir();
    initGitRepo(repoDir);
    const stateRoot = tmpDir();
    const env = { DCLI_STATE_ROOT: stateRoot };
    try {
      const r = dcli([
        'review', '--staged',
        '--hard-timeout-sec', '120',
        '--model', 'opencode-go/deepseek-v4-flash',
        '--repo', repoDir,
        '--json',
      ], { env, timeout: 150000 });
      assert.strictEqual(r.status, 0, `review --staged must succeed: ${r.stderr}`);
      // Parse unconditionally: exit 0 with empty or malformed stdout is exactly
      // the false green this suite exists to catch. A review that returns no
      // usable envelope has not completed.
      let parsed = null;
      try { parsed = JSON.parse((r.stdout || '').trim()); } catch {}
      assert.ok(parsed, `review --staged stdout must be a valid JSON envelope, got: ${(r.stdout || '').slice(0, 200)}`);
      assert.strictEqual(parsed.state, 'done',
        `review --staged must reach done, got ${parsed.state}. failure_reason: ${parsed.failure_reason || 'none'}`);
      assert.ok(parsed.job_id, 'review --staged envelope must carry a job_id');
      testLog(`P3.1 review --staged: state=${parsed.state}, findings_status=${parsed.findings_status}`);
      console.log('PASS: P3.1 review --staged completes');
    } finally {
      clean(repoDir); clean(stateRoot);
    }
  }

  // ==========================================================================
  // P3.2 — Review with --path completes
  // ==========================================================================
  {
    const repoDir = tmpDir();
    initGitRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'test.js'), 'console.log("hello");\n', 'utf8');
    cp.spawnSync('git', ['add', 'test.js'], { cwd: repoDir, windowsHide: true });
    const stateRoot = tmpDir();
    const env = { DCLI_STATE_ROOT: stateRoot };
    try {
      const r = dcli([
        'review', '--staged',
        '--hard-timeout-sec', '120',
        '--model', 'opencode-go/deepseek-v4-flash',
        '--repo', repoDir,
        '--path', 'test.js',
        '--json',
      ], { env, timeout: 150000 });
      assert.strictEqual(r.status, 0, `review --path must succeed: ${r.stderr}`);
      // Parse unconditionally — exit 0 with empty or malformed stdout is the
      // same false green P3.1 guards against; the review must actually complete.
      let parsed = null;
      try { parsed = JSON.parse((r.stdout || '').trim()); } catch {}
      assert.ok(parsed, `review --path stdout must be a valid JSON envelope, got: ${(r.stdout || '').slice(0, 200)}`);
      assert.strictEqual(parsed.state, 'done',
        `review --path must reach done, got ${parsed.state}. failure_reason: ${parsed.failure_reason || 'none'}`);
      assert.ok(parsed.job_id, 'review --path envelope must carry a job_id');
      console.log('PASS: P3.2 review --path completes');
    } finally {
      clean(repoDir); clean(stateRoot);
    }
  }

  // ==========================================================================
  // P3.3 — Raw backend events stay in backend-events.jsonl, not stdout
  // ==========================================================================
  {
    const repoDir = tmpDir();
    initGitRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, 'test.py'), 'print("hello")\n', 'utf8');
    cp.spawnSync('git', ['add', 'test.py'], { cwd: repoDir, windowsHide: true });
    const stateRoot = tmpDir();
    const env = { DCLI_STATE_ROOT: stateRoot };
    try {
      const r = dcli([
        'review', '--staged',
        '--hard-timeout-sec', '120',
        '--model', 'opencode-go/deepseek-v4-flash',
        '--repo', repoDir,
        '--json',
      ], { env, timeout: 150000 });

      // The command must actually have succeeded. A failure envelope is valid
      // JSON with no SSE markers and would sail through the checks below —
      // "events stayed out of stdout" must not pass for a review that failed.
      assert.strictEqual(r.status, 0, `review --staged must succeed: ${r.stderr}`);
      const stdout = (r.stdout || '').trim();
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch {}
      assert.ok(parsed, `stdout must be a valid JSON envelope, got: ${stdout.slice(0, 200)}`);
      assert.strictEqual(parsed.state, 'done',
        `review --staged must reach done, got ${parsed.state}. failure_reason: ${parsed.failure_reason || 'none'}`);
      assert.ok(parsed.job_id, 'envelope must carry a job_id');

      // stdout must be the parseable envelope, never raw SSE events
      assert.ok(!stdout.includes('data:'), 'stdout must not contain SSE data');
      assert.ok(!stdout.includes('event:'), 'stdout must not contain SSE event');

      // Raw backend events must be persisted in backend-events.jsonl for the
      // attempt, with content — the isolation claim is that they live there
      // instead of stdout, so the file must actually exist and be non-empty.
      const { computeRepoKeyWithPath } = require('../../../core/repo-key');
      const { repoKey } = computeRepoKeyWithPath(repoDir);
      const attemptDir = path.join(stateRoot, 'jobs', repoKey, parsed.job_id, 'attempts', '1');
      const eventsPath = path.join(attemptDir, 'backend-events.jsonl');
      assert.ok(fs.existsSync(eventsPath), `backend-events.jsonl must exist for the attempt (${eventsPath})`);
      const eventLines = fs.readFileSync(eventsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      assert.ok(eventLines.length > 0, 'backend-events.jsonl must contain persisted events');
      const events = eventLines.map((line, index) => {
        let event;
        try { event = JSON.parse(line); } catch (err) {
          assert.fail(`backend-events.jsonl line ${index + 1} must be JSON: ${err.message}`);
        }
        assert.ok(event && typeof event.type === 'string',
          `backend-events.jsonl line ${index + 1} must contain a fact type`);
        return event;
      });
      assert.ok(events.some(event => event.type === 'started'), 'persisted events must include started');
      assert.ok(events.some(event => event.type === 'process_exited'), 'persisted events must include process_exited');
      console.log('PASS: P3.3 raw backend events isolated from stdout');
    } finally {
      clean(repoDir); clean(stateRoot);
    }
  }

  console.log('\nAll P2/P3 option and review tests passed.');
}

const logs = [];
function testLog(msg) { logs.push(msg); }

main().catch(err => {
  for (const l of logs) console.log('  ', l);
  console.error('FAIL:', err.message);
  process.exit(1);
});
