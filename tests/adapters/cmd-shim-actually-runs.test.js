// @suite quick
// Ticket 80. `buildCmdInvocation` hand-builds a correctly quoted cmd.exe command
// line and hands it over as one pre-quoted argument — but the invocation carried
// no `windowsVerbatimArguments`, so child_process.spawn quoted it a SECOND time.
// cmd.exe then received literal \" characters and reported the whole string as
// an unrecognized program name. The shim never ran.
//
// The launch still looked fine from the parent: a child pid, no throw, no
// EINVAL. That is why `tests/adapters/opencode/cmd-shim-spawn.test.js` stayed
// green — it asserts only that spawn does not throw EINVAL, which is satisfied
// by a launch that executes nothing.
//
// So the assertions here are about the FIXTURE'S OWN observable behaviour: its
// stdout marker and its exit code. Nothing else proves it ran.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildCmdInvocation } = require('../../adapters/codex/cmd-quoting');

const MARKER = 'FIXTURE-RAN-80';
const FIXTURE_EXIT = 7;
const SPAWN_BUDGET_MS = 20000;

function writeFixture(dir, ext) {
  const p = path.join(dir, `marker-fixture.${ext}`);
  fs.writeFileSync(p, [
    '@echo off',
    `echo ${MARKER}`,
    `exit /b ${FIXTURE_EXIT}`,
    '',
  ].join('\r\n'), 'utf8');
  return p;
}

// Bounded, and the fixture tree is terminated and verified in the finally: a
// leaked fixture poisons every later test on the machine.
function runInvocation(invocation) {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: invocation.windowsHide,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.stdin.end();

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`fixture did not exit within ${SPAWN_BUDGET_MS}ms`));
    }, SPAWN_BUDGET_MS);

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function main() {

// ===========================================================================
// 1. A .cmd shim launched through buildCmdInvocation must actually execute.
//    Args are included because the re-escaping only breaks the line once it
//    contains a space — an argument-free shim would pass either way.
// ===========================================================================
for (const ext of ['cmd', 'bat']) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-t80-'));
  try {
    const fixture = writeFixture(tmp, ext);
    const invocation = buildCmdInvocation({
      command: fixture,
      args: ['--ephemeral', '-s', 'read-only', '-'],
      cwd: tmp,
    });

    assert.strictEqual(invocation.windowsVerbatimArguments, true,
      `.${ext} invocations must declare windowsVerbatimArguments, or spawn re-escapes the ` +
      'pre-quoted command line and cmd.exe never finds the shim');

    const { code, stdout, stderr } = await runInvocation(invocation);

    assert.ok(stdout.includes(MARKER),
      `.${ext} fixture must actually run and produce its marker. stdout=${JSON.stringify(stdout)} ` +
      `stderr=${JSON.stringify(stderr)}`);
    assert.strictEqual(code, FIXTURE_EXIT,
      `.${ext} fixture's own exit code must propagate, got ${code} (1 with an "is not recognized" ` +
      'stderr means cmd.exe was handed re-escaped quotes)');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ===========================================================================
// 2. The .exe pass-through branch must NOT set the flag — those args are a
//    normal argv array and need Node's own quoting.
// ===========================================================================
{
  const invocation = buildCmdInvocation({
    command: 'C:\\Program Files\\tool\\thing.exe',
    args: ['--flag', 'a value with spaces'],
    cwd: 'C:\\',
  });
  assert.strictEqual(invocation.command, 'C:\\Program Files\\tool\\thing.exe',
    'non-shim commands pass through unchanged');
  assert.ok(!invocation.windowsVerbatimArguments,
    'the pass-through branch must not set windowsVerbatimArguments — its args are a normal argv ' +
    'array and Node must quote them');
}

// ===========================================================================
// 3. Every adapter spawn site must forward the flag from the invocation it
//    built. A site that builds an invocation and drops one of its fields is
//    precisely this defect, so pin all three.
// ===========================================================================
for (const rel of [
  'adapters/codex/adapter.js',
  'adapters/claude/adapter.js',
  'adapters/opencode/server.js', // the opencode spawn site lives in the per-job server module (ticket 100)
]) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');
  assert.ok(/windowsVerbatimArguments:\s*invocation\.windowsVerbatimArguments/.test(src),
    `${rel} must forward invocation.windowsVerbatimArguments to spawn. Forward the invocation's own ` +
    'value, never a re-typed literal — the invocation is the single source of truth for how its ' +
    'command line was quoted.');
}

console.log('cmd-shim-actually-runs: all assertions passed');
}

main().catch(err => { console.error(err.stack || String(err)); process.exit(1); });
