// @suite quick
// Two regressions found by running the real backends, both of which left a
// job looking cleanly `done`:
//
// 1. codex's sandbox came only from `-s`, which codex-cli 0.146.0 ignores under
//    `--ignore-user-config`. `--access read-only` therefore did not sandbox at
//    all (the child wrote files), and `--access workspace` was refused with
//    "writing is blocked by read-only sandbox". `-c sandbox_mode=` is the flag
//    that takes effect, and write access additionally needs
//    `approvals_reviewer="auto_review"` or every patch is auto-rejected.
//
// 2. Both the codex and claude adapters took their working directory from
//    `process.cwd()` instead of the engine's `canonicalDir`, so every
//    implement-mode job ran against the invoking shell's directory and left
//    the job's worktree untouched — `diff` reported nothing changed.
//
// The workDir assertions deliberately do not go through a stub: the bug lived
// below the process boundary. They assert the child's own argv, not
// that spawn didn't throw.
const assert = require('node:assert');

function teardown(adapter) {
  if (adapter._childProcess) {
    try { adapter._childProcess.kill(); } catch {}
  }
  try { adapter.Dispose({}); } catch {}
}

async function main() {

// ===========================================================================
// 1. codex argv: sandbox_mode config is authoritative, and read-only carries
//    no auto-approving reviewer
// ===========================================================================
{
  const { buildArgv } = require('../../adapters/codex/adapter');

  const ro = buildArgv({ workDir: 'C:\\w', resultFilePath: 'C:\\t\\r.txt', sandbox: 'read-only' });
  assert.ok(ro.includes('-c'), 'read-only argv must carry -c overrides');
  assert.ok(ro.includes('sandbox_mode="read-only"'),
    '-s is ignored by codex; sandbox_mode must be set via -c');
  assert.ok(!ro.some(a => String(a).includes('approvals_reviewer')),
    'a read-only job must never auto-approve writes');

  const ws = buildArgv({ workDir: 'C:\\w', resultFilePath: 'C:\\t\\r.txt', sandbox: 'workspace-write' });
  assert.ok(ws.includes('sandbox_mode="workspace-write"'),
    'workspace access must be expressed as -c sandbox_mode');
  assert.ok(ws.includes('approvals_reviewer="auto_review"'),
    'workspace-write patches are auto-rejected without approvals_reviewer');

  // The default must stay closed when no sandbox is supplied.
  const dflt = buildArgv({ workDir: 'C:\\w', resultFilePath: 'C:\\t\\r.txt' });
  assert.ok(dflt.includes('sandbox_mode="read-only"'), 'default sandbox must be read-only');
  assert.ok(!dflt.some(a => String(a).includes('approvals_reviewer')),
    'default must not auto-approve writes');

  console.log('PASS: codex sandbox flags');
}

// ===========================================================================
// 2. codex Start() runs in canonicalDir, not process.cwd()
// ===========================================================================
{
  const { CodexAdapter } = require('../../adapters/codex/adapter');
  const adapter = new CodexAdapter({});
  const savedPath = process.env.CODEX_PATH;
  process.env.CODEX_PATH = process.env.ComSpec || 'cmd.exe';

  const canonicalDir = process.platform === 'win32' ? 'C:\\Windows' : '/tmp';
  try {
    adapter.PrepareInvocation({}, { canonicalDir, access: 'read-only' });
    await adapter.Start({});
    const argv = (adapter._childProcess.spawnargs || []).join(' ');
    assert.ok(argv.includes(canonicalDir),
      `codex child argv must carry -C canonicalDir; got: ${argv.slice(0, 300)}`);
    assert.strictEqual(adapter._workDir, canonicalDir,
      'codex child must run in canonicalDir, not process.cwd()');
  } finally {
    teardown(adapter);
    if (savedPath === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = savedPath;
  }

  console.log('PASS: codex Start uses canonicalDir');
}

// ===========================================================================
// 3. claude Start() runs in canonicalDir, not process.cwd()
// ===========================================================================
{
  const { ClaudeAdapter } = require('../../adapters/claude/adapter');
  const adapter = new ClaudeAdapter({});
  const savedPath = process.env.CLAUDE_PATH;
  process.env.CLAUDE_PATH = process.env.ComSpec || 'cmd.exe';

  const canonicalDir = process.platform === 'win32' ? 'C:\\Windows' : '/tmp';
  try {
    adapter.PrepareInvocation({}, { canonicalDir, access: 'read-only' });
    await adapter.Start({});
    // claude receives the directory only as the spawn cwd, never in argv.
    assert.ok(adapter._childProcess, 'claude child must have been launched');
    assert.strictEqual(adapter._workDir, canonicalDir,
      'claude child must run in canonicalDir, not process.cwd()');
  } finally {
    teardown(adapter);
    if (savedPath === undefined) delete process.env.CLAUDE_PATH;
    else process.env.CLAUDE_PATH = savedPath;
  }

  console.log('PASS: claude Start uses canonicalDir');
}

}

main().then(() => console.log('\nAll sandbox/workdir tests passed')).catch((err) => {
  console.error('FAIL:', err && err.stack || err);
  process.exit(1);
});
