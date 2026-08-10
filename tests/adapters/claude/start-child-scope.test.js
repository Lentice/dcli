// @suite quick
// Covers the real Start() path in adapters/claude/adapter.js.
//
// The adapter used to open Start() with `if (this._testMode) { ...; return }`,
// and every adapter test set _testMode, so the code below that guard was
// executed by nothing in the suite. That blind spot is what let a
// `ReferenceError: child is not defined` ship in the codex adapter and break
// every job. This test walks the real spawn path so the same class of defect
// cannot reach a release here.
const assert = require('node:assert');

// cmd.exe launched with claude's arguments is a hang-shaped fixture (an
// interactive shell). Teardown runs in a finally in every case below: a leaked
// fixture poisons every later test on the machine.
function teardown(adapter) {
  if (adapter._childProcess) {
    try { adapter._childProcess.kill(); } catch {}
  }
  try { adapter.Dispose({}); } catch {}
}

async function startWithStubBinary(adapter, extraEnv = {}) {
  const saved = { CLAUDE_PATH: process.env.CLAUDE_PATH };
  for (const key of Object.keys(extraEnv)) saved[key] = process.env[key];

  // cmd.exe spawns successfully and is not claude; Start() only has to launch
  // the child and wire its streams, which is exactly what is under test.
  process.env.CLAUDE_PATH = process.env.ComSpec || 'cmd.exe';
  for (const [key, value] of Object.entries(extraEnv)) process.env[key] = value;

  try {
    return { result: await adapter.Start({}), error: undefined };
  } catch (err) {
    return { result: undefined, error: err };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function main() {

// ===========================================================================
// 1. A successful spawn produces a usable handle with all listeners armed
// ===========================================================================
{
  const { ClaudeAdapter } = require('../../../adapters/claude/adapter');
  const adapter = new ClaudeAdapter({});

  const { result, error } = await startWithStubBinary(adapter);

  try {
    assert.ok(!error, `Start must not throw on a successful spawn: ${error && error.stack}`);
    assert.ok(!(error instanceof ReferenceError), 'Start must not throw ReferenceError');
    assert.ok(!(error instanceof TypeError), 'Start must not throw TypeError');

    assert.strictEqual(result.handle, 'claude-process');
    assert.strictEqual(typeof result.pid, 'number', 'handle must carry the child pid');
    assert.strictEqual(adapter._processPid, result.pid, '_processPid must match the handle pid');
    assert.ok(adapter._childProcess, '_childProcess must be retained for SendPrompt');

    // Start() mints a session id when the request carries none; SendPrompt and
    // reconciliation both depend on it.
    assert.ok(result.sessionId, 'handle must carry a session id');
    assert.strictEqual(adapter._sessionId, result.sessionId);

    // Readers must be armed in Start, before any stdin write. A child that fills
    // an OS pipe before draining its own stdin deadlocks parent against child.
    assert.strictEqual(adapter._stdoutClosed, false, 'stdout close tracking must be armed');
    assert.strictEqual(adapter._stderrClosed, false, 'stderr close tracking must be armed');
    assert.ok(adapter._childProcess.stdout.listenerCount('data') > 0,
      'stdout data reader must be armed in Start');
    assert.ok(adapter._childProcess.stderr.listenerCount('data') > 0,
      'stderr data reader must be armed in Start');
    assert.ok(adapter._childProcess.listenerCount('exit') > 0, 'exit handler must be armed');
    assert.ok(adapter._childProcess.listenerCount('error') > 0, 'error handler must be armed');
  } finally {
    teardown(adapter);
  }

  console.log('PASS: claude Start wires the spawned child and returns a usable handle');
}

// ===========================================================================
// 2. The recursion guard is stamped into the child, not into the parent
//    A delegated claude that can re-delegate to itself is an unbounded fork
//    bomb, so the sentinel matters -- but stamping it into the parent's own
//    environment would make every later spawn in this process look like a
//    worker.
// ===========================================================================
{
  const { ClaudeAdapter } = require('../../../adapters/claude/adapter');
  const adapter = new ClaudeAdapter({});

  const parentWorkerBefore = process.env.DCLI_WORKER;
  const { error } = await startWithStubBinary(adapter, { DCLI_DEPTH: '2' });

  try {
    assert.ok(!error, `Start must not throw: ${error && error.stack}`);
    assert.strictEqual(process.env.DCLI_WORKER, parentWorkerBefore,
      'Start must not stamp the recursion guard into the parent environment');
  } finally {
    teardown(adapter);
  }

  console.log('PASS: claude Start does not leak the recursion guard into the parent env');
}

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
