// @suite full
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const POST_EXIT_DRAIN_MS = 3000;

async function main() {

// ===========================================================================
// 1. Stream close events fire promptly for normal processes
// ===========================================================================
{
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("hello\\n");process.exit(0)'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');

  let stdoutContent = '';
  let stdoutClosed = false;
  let stderrClosed = false;

  child.stdout.on('data', (chunk) => { stdoutContent += chunk; });
  child.stdout.on('close', () => { stdoutClosed = true; });
  child.stderr.on('close', () => { stderrClosed = true; });

  const exit = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
  assert.strictEqual(exit, 0);

  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (stdoutClosed) break;
    await new Promise(r => setTimeout(r, 10));
  }

  assert.ok(stdoutClosed, 'stdout must close after normal exit');
  assert.ok(stdoutContent.includes('hello'), 'stdout content must be captured');
  console.log('PASS: stream-drain test 1 — normal process streams close');
}

// ===========================================================================
// 2. _waitForStreamDrain pattern: streams close within bound
// ===========================================================================
{
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("data\\n");process.exit(0)'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');

  let stdoutContent = '';
  let stdoutClosed = false;
  let stderrClosed = false;

  child.stdout.on('data', (chunk) => { stdoutContent += chunk; });
  child.stdout.on('close', () => { stdoutClosed = true; });
  child.stderr.on('close', () => { stderrClosed = true; });

  await new Promise((resolve) => { child.on('exit', () => resolve()); });

  let drainTimedOut = false;
  const drainDeadline = Date.now() + POST_EXIT_DRAIN_MS;
  while (Date.now() < drainDeadline) {
    if (stdoutClosed && stderrClosed) break;
    await new Promise(r => setTimeout(r, 10));
  }
  if (!stdoutClosed || !stderrClosed) drainTimedOut = true;

  assert.strictEqual(drainTimedOut, false, 'drain must not time out for normal process');
  assert.ok(stdoutContent.includes('data'), 'stdout must contain data');
  console.log('PASS: stream-drain test 2 — drain completes within bound');
}



}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
