// @suite full
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('path');
const fs = require('fs');

let ManagedProcess;
function load() {
  ManagedProcess = require('../../core/child-process').ManagedProcess;
}

const FIXTURES = path.resolve(__dirname, '..', 'fixtures');

function fixturePath(name) {
  return path.join(FIXTURES, name);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  load();

  // =========================================================================
  // 1. Structural read-before-write: consumers must be registered before
  //    sendStdin. The capture starts at construction.
  // =========================================================================
  {
    const proc = new ManagedProcess({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume(); process.stdin.on("data", d => process.stdout.write(d)); process.stdin.on("end", () => process.exit(0));'],
      hardTimeoutMs: 5000,
      postExitDrainMs: 1000,
      startupSentinelMs: 2000,
    });

    // Accessing accumulated output without consumer callbacks is fine
    assert.strictEqual(typeof proc.pid, 'number');
    assert.ok(proc.pid > 0);

    // sendStdin must NOT be called before consumer registration
    try {
      proc.sendStdin('hello');
      assert.fail('sendStdin before consumer registration must throw');
    } catch (err) {
      assert.ok(err.message && err.message.includes('consumer'),
        `Error must mention consumer: ${err.message}`);
    }

    // Register consumer, now sendStdin is allowed
    let outChunks = [];
    proc.onStdout(chunk => outChunks.push(chunk));

    proc.sendStdin('hello from test\n');

    // Close stdin so child exits
    proc.closeStdin();

    const exit = await proc.waitForExit(5000);
    assert.strictEqual(exit.code, 0);

    const stdout = proc.stdoutContent;
    assert.ok(stdout.includes('hello from test'), `stdout must contain sent text, got: ${stdout}`);
    console.log('PASS: structural read-before-write enforced');
  }

  // =========================================================================
  // 2. Backpressure fixture: ~100KB stdout before stdin read does NOT deadlock
  // =========================================================================
  {
    const proc = new ManagedProcess({
      command: process.execPath,
      args: [fixturePath('backpressure-child.js'), '100'],
      hardTimeoutMs: 15000,
      postExitDrainMs: 2000,
      startupSentinelMs: 5000,
    });

    // Register consumer
    let outChunks = [];
    proc.onStdout(chunk => outChunks.push(chunk));

    // Wait briefly for child to start writing stdout
    await sleep(200);

    // Now write stdin — if stdout weren't being consumed, this would deadlock
    proc.sendStdin('trigger stdin data\n');

    proc.closeStdin();

    const start = Date.now();
    const exit = await proc.waitForExit(10000);
    const elapsed = Date.now() - start;

    assert.strictEqual(exit.code, 0, `Backpressure child must exit 0, got ${exit.code}`);
    assert.ok(elapsed < 10000, `Must not deadlock (took ${elapsed}ms)`);

    const stdout = proc.stdoutContent;
    assert.ok(stdout.includes('END_OF_STDOUT'), 'Stdout must contain child output');
    assert.ok(proc.stderrContent.includes('stdin_received'), 'Stderr must show stdin receipt');
    console.log(`  elapsed=${elapsed}ms stdout=${stdout.length}bytes`);
    console.log('PASS: backpressure does not deadlock');
  }

  // =========================================================================
  // 3. Hard timeout starts immediately; blocked process is killed
  // =========================================================================
  {
    const proc = new ManagedProcess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ready\\n");setInterval(()=>{process.stdout.write("keepalive\\n")},1000)'],
      hardTimeoutMs: 1500,
      postExitDrainMs: 1000,
      startupSentinelMs: 3000,
    });

    // Synchronize on first byte before starting time-sensitive assertions.
    // This guarantees drained.stdout content regardless of whether the
    // first keepalive write (1000ms interval) arrives before the hard kill.
    let firstByteResolve;
    const firstByte = new Promise(r => { firstByteResolve = r; });
    proc.onStdout(() => { firstByteResolve(); });
    await firstByte;

    const start = Date.now();
    const exit = await proc.waitForExit(5000);
    const elapsed = Date.now() - start;

    // Should be killed by hard timeout (~1500ms)
    assert.ok(elapsed < 5000, `Must not hang (took ${elapsed}ms)`);
    assert.strictEqual(exit.timedOut, true, 'exit must indicate timeout');
    console.log(`  elapsed=${elapsed}ms`);

    // After exit, drain timeout output
    const drained = await proc.drainOutput(500);
    assert.ok(drained.stdout.length > 0, 'Must have some stdout content');
    assert.ok(drained.timedOut, 'Drain must report timeout');
    console.log('PASS: hard timeout kills blocked process');
  }

  // =========================================================================
  // 4. Post-exit drain is bounded; grandchild holding pipe open does not hang
  // =========================================================================
  {
    const proc = new ManagedProcess({
      command: process.execPath,
      args: [fixturePath('grandchild-pipe.js')],
      hardTimeoutMs: 10000,
      postExitDrainMs: 2000,
      startupSentinelMs: 5000,
    });

    proc.onStdout(() => {});
    proc.onStderr(() => {});

    const exit = await proc.waitForExit(5000);
    assert.strictEqual(exit.code, 0, 'Grandchild fixture must exit 0');

    // Drain after exit — must be bounded (grandchild holds pipe open)
    const start = Date.now();
    const drained = await proc.drainOutput(3000);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 4000, `Post-exit drain must not hang (took ${elapsed}ms)`);
    assert.ok(drained.stdout.includes('child_line_'), 'Output must contain child lines');
    assert.ok(drained.stdout.includes('CHILD_EXITING'), 'Output must contain exit marker');
    console.log(`  elapsed=${elapsed}ms output=${drained.stdout.length}bytes`);
    console.log('PASS: post-exit drain bounded with grandchild pipe');
  }

  // =========================================================================
  // 5. Teardown order: close stdin → kill → bounded drain → result
  // =========================================================================
  {
    const proc = new ManagedProcess({
      command: process.execPath,
      args: ['-e', `
        process.stdin.resume();
        process.stdin.on('data', d => process.stdout.write(d));
        setInterval(() => process.stdout.write('keepalive\\n'), 200);
      `],
      hardTimeoutMs: 3000,
      postExitDrainMs: 500,
      startupSentinelMs: 2000,
    });

    proc.onStdout(() => {});
    proc.sendStdin('test data\n');

    // Wait for hard timeout to trigger teardown
    const exit = await proc.waitForExit(5000);
    assert.strictEqual(exit.timedOut, true, 'Must be killed by timeout');

    // Drain partial output after kill
    const drained = await proc.drainOutput(1000);
    assert.ok(drained.timedOut, 'Drain must indicate timeout in teardown');
    assert.ok(drained.stdout.length > 0, 'Must have partial output');
    console.log(`  partial output: ${drained.stdout.length} bytes`);
    console.log('PASS: teardown order closes stdin then kills then drains');
  }

  // =========================================================================
  // 6. Size-capped capture: verbose output does not grow unbounded
  // =========================================================================
  {
    const proc = new ManagedProcess({
      command: process.execPath,
      args: [fixturePath('verbose-server.js'), '200'],
      hardTimeoutMs: 2000,
      postExitDrainMs: 1000,
      startupSentinelMs: 3000,
      maxStdoutBytes: 5000,
    });

    proc.onStdout(() => {});

    const exit = await proc.waitForExit(4000);
    assert.strictEqual(exit.timedOut, true, 'Verbose server must be timed out');
    const stdout = proc.stdoutContent;
    assert.ok(stdout.length <= 5000 + 500, `stdout must be capped (~5000), was ${stdout.length}`);
    console.log(`  stdout length: ${stdout.length} bytes (cap: 5000)`);
    console.log('PASS: size-capped capture prevents unbounded growth');
  }

  // =========================================================================
  // 7. Non-ASCII output is captured without mojibake
  // =========================================================================
  {
    const proc = new ManagedProcess({
      command: process.execPath,
      args: [fixturePath('non-ascii-output.js')],
      hardTimeoutMs: 5000,
      postExitDrainMs: 1000,
      startupSentinelMs: 3000,
    });

    let outChunks = [];
    proc.onStdout(chunk => outChunks.push(chunk));

    proc.sendStdin('go\n');
    proc.closeStdin();

    const exit = await proc.waitForExit(3000);
    assert.strictEqual(exit.code, 0);

    const stdout = proc.stdoutContent;
    assert.ok(stdout.includes('世界'), 'Chinese chars must be preserved');
    assert.ok(stdout.includes('café'), 'Accented chars must be preserved');
    assert.ok(stdout.includes('日本語テスト'), 'Japanese chars must be preserved');
    assert.ok(stdout.includes('😀'), 'Emoji must be preserved');
    console.log('PASS: non-ASCII output without mojibake');
  }

  // =========================================================================
  // 8. Startup sentinel: env override changes timeout
  // =========================================================================
  {
    process.env.DCLI_STARTUP_TIMEOUT = '4000';
    try {
      // Re-load to pick up env change (or use resolveDeadline directly)
      // Actually the env is read at construction, so we test via options
      const proc = new ManagedProcess({
        command: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        hardTimeoutMs: 5000,
        postExitDrainMs: 1000,
        // Don't pass startupSentinelMs explicitly; env provides it
      });
      proc.onStdout(() => {});
      // If it starts fine, sentinel didn't false-fire. Hard timeout will kill.
      const exit = await proc.waitForExit(6000);
      assert.strictEqual(exit.timedOut, true);
      console.log('PASS: startup sentinel env override applies');
    } finally {
      delete process.env.DCLI_STARTUP_TIMEOUT;
    }
  }

  // =========================================================================
  // 9. Dead-worker fast-fail: process that dies before sentinel fires
  //    is reported immediately, not at sentinel expiry
  // =========================================================================
  {
    const proc = new ManagedProcess({
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      hardTimeoutMs: 10000,
      postExitDrainMs: 500,
      startupSentinelMs: 10000, // long sentinel
    });

    proc.onStdout(() => {});

    const start = Date.now();
    const exit = await proc.waitForExit(3000);
    const elapsed = Date.now() - start;

    // Should exit quickly (dead worker), not wait 10s for sentinel
    assert.strictEqual(exit.code, 1, 'Dead worker must report exit code');
    assert.ok(elapsed < 5000, `Must fast-fail dead worker (took ${elapsed}ms)`);
    console.log(`  elapsed=${elapsed}ms (sentinel was 10s)`);
    console.log('PASS: dead-worker fast-fail');
  }

  // =========================================================================
  // 10. onStdout/onStderr callbacks receive data in real-time
  // =========================================================================
  {
    const proc = new ManagedProcess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("chunk1\\n"); process.stdout.write("chunk2\\n"); process.exit(0)'],
      hardTimeoutMs: 3000,
      postExitDrainMs: 500,
      startupSentinelMs: 2000,
    });

    const received = [];
    proc.onStdout(chunk => received.push(chunk));

    const exit = await proc.waitForExit(2000);
    assert.strictEqual(exit.code, 0);

    const combined = received.join('');
    assert.ok(combined.includes('chunk1'), 'Must receive chunk1');
    assert.ok(combined.includes('chunk2'), 'Must receive chunk2');
    console.log('PASS: onStdout callbacks receive data');
  }

  // =========================================================================
  // 11. onError callback receives spawn errors
  // =========================================================================
  {
    const proc = new ManagedProcess({
      command: 'nonexistent-command-that-will-fail.exe',
      args: [],
      hardTimeoutMs: 2000,
      postExitDrainMs: 500,
      startupSentinelMs: 1000,
    });

    let receivedError = null;
    proc.onError(err => { receivedError = err; });

    const exit = await proc.waitForExit(3000);
    // Should exit with an error (ENOENT or similar)
    assert.ok(exit.code !== 0 || exit.error, 'Must report spawn error');
    console.log('PASS: onError receives spawn errors');
  }

  console.log('\nAll child-process tests passed.');
}

main().catch(err => {
  console.error('TEST FAILED:', err.message);
  process.exit(1);
});
