// @suite full
// @serial  live backend
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
  // P2.2 — --reasoning-effort is rejected by opencode adapter
  // ==========================================================================
  {
    const r = dcli(['run', '--hard-timeout-sec', '5', '--reasoning-effort', 'high', 'test']);
    assert.notStrictEqual(r.status, 0, '--reasoning-effort must be rejected');
    assert.ok(r.stderr.includes('not supported') || r.stderr.includes('reasoning-effort'),
      `--reasoning-effort rejection stderr: ${r.stderr}`);
    console.log(`PASS: P2.2 --reasoning-effort rejected (exit ${r.status})`);
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
      let jsonOut = null;
      try { jsonOut = JSON.parse((r.stdout || '').trim()); } catch {}
      const isRejected = r.status === 2 ||
        (jsonOut && jsonOut.failure_class === 'usage_error');
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
        '--hard-timeout-sec', '60',
        '--model', 'opencode-go/deepseek-v4-flash',
        '--repo', repoDir,
        '--json',
      ], { env, timeout: 90000 });
      assert.strictEqual(r.status, 0, `review --staged must succeed: ${r.stderr}`);
      let parsed = null;
      try { parsed = JSON.parse((r.stdout || '').trim()); } catch {}
      if (parsed) {
        testLog(`P3.1 review --staged: state=${parsed.state}, findings_status=${parsed.findings_status}`);
      }
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
        '--hard-timeout-sec', '60',
        '--model', 'opencode-go/deepseek-v4-flash',
        '--repo', repoDir,
        '--path', 'test.js',
        '--json',
      ], { env, timeout: 90000 });
      assert.strictEqual(r.status, 0, `review --path must succeed: ${r.stderr}`);
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
        '--hard-timeout-sec', '60',
        '--model', 'opencode-go/deepseek-v4-flash',
        '--repo', repoDir,
        '--json',
      ], { env, timeout: 90000 });

      // stdout must be parseable JSON (the envelope), not raw SSE events
      const stdout = (r.stdout || '').trim();
      try {
        JSON.parse(stdout);
      } catch {
        assert.fail(`stdout must be valid JSON, got: ${stdout.slice(0, 200)}`);
      }
      // Must NOT contain SSE framing or raw event markers
      assert.ok(!stdout.includes('data:'), 'stdout must not contain SSE data');
      assert.ok(!stdout.includes('event:'), 'stdout must not contain SSE event');
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
