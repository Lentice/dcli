const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const RUNNER = path.resolve(__dirname, '..', 'run-tests.js');
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const FIXTURE_TIMEOUT = 1500;
const MARKER = path.join(os.tmpdir(), 'dcli-serial-marker-test');
const HANG_PID = path.join(os.tmpdir(), 'dcli-hang-pid.txt');

const RUNNER_BIN = process.execPath;

async function main() {
  const { runTests } = require(RUNNER);

  try { fs.unlinkSync(MARKER); } catch {}
  try { fs.unlinkSync(HANG_PID); } catch {}

  try {
    // -----------------------------------------------------------------------
    // 1. Byte-exact output at different concurrency
    // -----------------------------------------------------------------------
    {
      const r1 = await runTests({ root: FIXTURES_DIR, concurrency: 1, timeoutMs: FIXTURE_TIMEOUT, suite: 'full' });
      const r2 = await runTests({ root: FIXTURES_DIR, concurrency: 3, timeoutMs: FIXTURE_TIMEOUT, suite: 'full' });
      assert.strictEqual(r1.output, r2.output, 'Byte-exact output must match at different concurrency');

      assert.ok(!r1.output.includes('parallel-check.test.js'), 'Serial exclusivity: parallel-check must not appear in failures');
      assert.ok(r1.output.includes('fail.test.js'), 'fail fixture should appear in failures');
      assert.ok(r1.output.includes('HANG: about to hang'), 'hang fixture stdout should appear in output');
      assert.ok(r1.output.includes('exit code: 1'), 'Exit code 1 must be reported');
      assert.ok(r1.output.includes('FAIL_OUT'), 'Failing stdout must appear in output');
      assert.ok(r1.output.includes('FAIL_ERR'), 'Failing stderr must appear in output');
    }

    // -----------------------------------------------------------------------
    // 2. Quick suite excludes @suite full, names skipped files
    // -----------------------------------------------------------------------
    {
      const r = await runTests({ root: FIXTURES_DIR, concurrency: 2, timeoutMs: FIXTURE_TIMEOUT, suite: 'quick' });
      assert.ok(r.output.includes('(skipped)'), 'Quick suite must name skipped files');
      assert.ok(r.output.includes('suite-full.test.js'), 'Quick suite must name each skipped file');
      assert.ok(!r.output.includes('PASS: suite-full.test.js'), 'Quick suite must not run @suite full files');
    }

    // -----------------------------------------------------------------------
    // 3. Hang fixture is terminated and reported as timeout, distinctly from failure
    // -----------------------------------------------------------------------
    {
      const r = await runTests({ root: FIXTURES_DIR, concurrency: 1, timeoutMs: 1000, suite: 'full' });
      assert.ok(r.output.includes('timed out after 1000 ms'), 'Hang fixture must be reported with duration');
      assert.ok(r.anyFailed, 'Timeout must cause anyFailed=true');
    }

    // -----------------------------------------------------------------------
    // 4. Usage errors exit 2
    // -----------------------------------------------------------------------
    {
      const r1 = spawnSync(RUNNER_BIN, [RUNNER, '--concurrency', '--suite', 'quick'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      assert.strictEqual(r1.status, 2, 'Missing concurrency value must exit 2');
      const r2 = spawnSync(RUNNER_BIN, [RUNNER, '--concurrency', 'abc'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      assert.strictEqual(r2.status, 2, 'Non-integer concurrency must exit 2');
      const r3 = spawnSync(RUNNER_BIN, [RUNNER, '--concurrency', '99'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      assert.strictEqual(r3.status, 2, 'Out-of-range concurrency must exit 2');
      const r4 = spawnSync(RUNNER_BIN, [RUNNER, '--timeout-ms', '--suite', 'full'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      assert.strictEqual(r4.status, 2, 'Missing timeout-ms value must exit 2');
      const r5 = spawnSync(RUNNER_BIN, [RUNNER, '--timeout-ms', '999'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      assert.strictEqual(r5.status, 2, 'Out-of-range timeout-ms must exit 2');
      const r6 = spawnSync(RUNNER_BIN, [RUNNER, '--suite'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      assert.strictEqual(r6.status, 2, 'Missing suite value must exit 2');
      const r7 = spawnSync(RUNNER_BIN, [RUNNER, '--suite', 'unknown'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      assert.strictEqual(r7.status, 2, 'Bad suite value must exit 2');
      // Reject positional arguments
      const r8 = spawnSync(RUNNER_BIN, [RUNNER, 'garbage'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      assert.strictEqual(r8.status, 2, 'Positional argument must exit 2');
    }

    console.log('PASS: all test-runner tests');
  } finally {
    try { fs.unlinkSync(MARKER); } catch {}

    // Verify hang fixture process tree is gone
    let hangPid;
    try {
      const text = fs.readFileSync(HANG_PID, 'utf8').trim();
      hangPid = parseInt(text, 10);
    } catch {
      // PID file missing — fixture may have been killed before writing
    }

    if (hangPid) {
      try {
        process.kill(hangPid, 0);
        console.error('FAIL: hang fixture process still alive after timeout');
        process.exit(1);
      } catch {}
      try { fs.unlinkSync(HANG_PID); } catch {}
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
