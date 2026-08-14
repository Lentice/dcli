// @serial  owns fixed temp markers and creates a nested fixture process pool
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const RUNNER = path.resolve(__dirname, '..', 'run-tests.js');
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const { assertSpawnStatus } = require('../helpers/spawn-assert');
// The nested runner starts several child Node processes; 5 s flakes when the
// outer full suite is concurrently creating git and backend fixtures.
const FIXTURE_TIMEOUT = 10000;
const RUNNER_BIN = process.execPath;

async function main() {
  const { runTests, createOutputCapture } = require(RUNNER);
  const fixtureTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-runner-fixtures-'));
  const marker = path.join(fixtureTmp, 'serial-marker');
  const hangPidFile = path.join(fixtureTmp, 'hang-pid.txt');
  const previousFixtureTmp = process.env.DCLI_TEST_RUNNER_TMP;
  process.env.DCLI_TEST_RUNNER_TMP = fixtureTmp;

  try {
    // -----------------------------------------------------------------------
    // 1. Byte-exact output at different concurrency
    // -----------------------------------------------------------------------
    {
      const r1 = await runTests({ root: FIXTURES_DIR, concurrency: 1, timeoutMs: FIXTURE_TIMEOUT, suite: 'full' });
      const r2 = await runTests({ root: FIXTURES_DIR, concurrency: 3, timeoutMs: FIXTURE_TIMEOUT, suite: 'full' });
      const withoutTimings = (output) => output
        .replace(/\n\n--- LOAD ---[\s\S]*$/, '')
        .replace(/\d+ ms \/ \d+ ms/g, '<timing>');
      assert.strictEqual(
        withoutTimings(r1.output),
        withoutTimings(r2.output),
        'Output other than measured timings must match at different concurrency',
      );

      assert.ok(
        !/parallel-check\.test\.js\s+\((?:exit code|timed out)/.test(r1.output),
        'Serial exclusivity: parallel-check must not appear in failures',
      );
      assert.ok(r1.output.includes('fail.test.js'), 'fail fixture should appear in failures');
      assert.ok(r1.output.includes('HANG: about to hang'), 'hang fixture stdout should appear in output');
      assert.ok(r1.output.includes('exit code: 1'), 'Exit code 1 must be reported');
      assert.ok(r1.output.includes('FAIL_OUT'), 'Failing stdout must appear in output');
      assert.ok(r1.output.includes('FAIL_ERR'), 'Failing stderr must appear in output');
      assert.match(
        r1.output,
        /pass\.test\.js\s+\(\d+ ms \/ 10000 ms\)/,
        'each file must report elapsed time next to its effective budget',
      );
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
    // 3. A file-level timeout overrides the suite default without making it unbounded
    // -----------------------------------------------------------------------
    {
      const r = await runTests({ root: FIXTURES_DIR, concurrency: 1, timeoutMs: 1000, suite: 'full' });
      assert.ok(!r.output.includes('slow-timeout.test.js  (timed out'), 'slow fixture must not use the shorter suite timeout');
      assert.match(
        r.output,
        /slow-timeout\.test\.js\s+\(\d+ ms \/ 10000 ms\)/,
        'the slow fixture must finish within its finite file-level override',
      );
    }

    // -----------------------------------------------------------------------
    // 4. Direct callers cannot create a zero-worker pool that never resolves
    // -----------------------------------------------------------------------
    {
      await assert.rejects(
        () => runTests({ root: FIXTURES_DIR, concurrency: 0, timeoutMs: 1000, suite: 'full' }),
        /concurrency must be an integer between 1 and 64/,
      );
    }

    // -----------------------------------------------------------------------
    // 5. Output capture retains a bounded head and tail while reporting loss
    // -----------------------------------------------------------------------
    {
      const capture = createOutputCapture(10);
      capture.append(Buffer.from('abcdef'));
      capture.append(Buffer.from('ghijklmnop'));
      const rendered = capture.render();
      assert.ok(rendered.startsWith('abcde'), 'bounded capture must retain the output head');
      assert.ok(rendered.endsWith('lmnop'), 'bounded capture must retain the output tail');
      assert.ok(rendered.includes('6 bytes dropped'), 'bounded capture must state dropped bytes');
    }

    // -----------------------------------------------------------------------
    // 6. Hang fixture is terminated and reported as timeout, distinctly from failure
    // -----------------------------------------------------------------------
    {
      const r = await runTests({ root: FIXTURES_DIR, concurrency: 1, timeoutMs: 1000, suite: 'full' });
      assert.ok(r.output.includes('timed out after 1000 ms'), 'Hang fixture must be reported with duration');
      assert.ok(r.anyFailed, 'Timeout must cause anyFailed=true');
      assert.match(
        r.output,
        /--- LOAD ---[\s\S]*hang\.test\.js\s+\(\d+ ms \/ 1000 ms, \d+% of budget\)/,
        'Near-cap fixtures must still be reported in the load section',
      );
    }

    // -----------------------------------------------------------------------
    // 7. Usage errors exit 2
    // -----------------------------------------------------------------------
    {
      const r1 = spawnSync(RUNNER_BIN, [RUNNER, '--concurrency', '--suite', 'quick'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      assertSpawnStatus(r1, 2, 'Missing concurrency value must exit 2', 10000);
      const r2 = spawnSync(RUNNER_BIN, [RUNNER, '--concurrency', 'abc'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      assertSpawnStatus(r2, 2, 'Non-integer concurrency must exit 2', 10000);
      const r3 = spawnSync(RUNNER_BIN, [RUNNER, '--concurrency', '99'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      assertSpawnStatus(r3, 2, 'Out-of-range concurrency must exit 2', 10000);
      const r4 = spawnSync(RUNNER_BIN, [RUNNER, '--timeout-ms', '--suite', 'full'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      assertSpawnStatus(r4, 2, 'Missing timeout-ms value must exit 2', 10000);
      const r5 = spawnSync(RUNNER_BIN, [RUNNER, '--timeout-ms', '999'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      assertSpawnStatus(r5, 2, 'Out-of-range timeout-ms must exit 2', 10000);
      const r6 = spawnSync(RUNNER_BIN, [RUNNER, '--suite'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      assertSpawnStatus(r6, 2, 'Missing suite value must exit 2', 10000);
      const r7 = spawnSync(RUNNER_BIN, [RUNNER, '--suite', 'unknown'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      assertSpawnStatus(r7, 2, 'Bad suite value must exit 2', 10000);
      // Reject positional arguments
      const r8 = spawnSync(RUNNER_BIN, [RUNNER, 'garbage'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      assertSpawnStatus(r8, 2, 'Positional argument must exit 2', 10000);
    }

    console.log('PASS: all test-runner tests');
  } finally {
    // Verify hang fixture process tree is gone
    let hangPid;
    try {
      const text = fs.readFileSync(hangPidFile, 'utf8').trim();
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
    }
    if (previousFixtureTmp === undefined) delete process.env.DCLI_TEST_RUNNER_TMP;
    else process.env.DCLI_TEST_RUNNER_TMP = previousFixtureTmp;
    fs.rmSync(fixtureTmp, { recursive: true, force: true });
    assert.ok(!fs.existsSync(fixtureTmp), 'owned fixture temp directory must be removed');
    assert.ok(!fs.existsSync(marker), 'serial marker must not leak');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
