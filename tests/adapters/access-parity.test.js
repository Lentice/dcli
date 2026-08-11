// @suite quick
// Parity gate (ticket 108): every --access value the parser accepts must mean
// the same thing to every backend adapter. This test exists because
// `--access full` was accepted by the parser, granted unrestricted
// repository-and-external access on opencode, and silently downgraded to
// read-only on codex/claude. The accepted set is DERIVED from
// core/cli-args.js — never hard-coded here — so the gate cannot rot.
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { ACCESS_VALUES } = require('../../core/cli-args');
const { OpencodeAdapter } = require('../../adapters/opencode/adapter');
const { CodexAdapter } = require('../../adapters/codex/adapter');
const { ClaudeAdapter } = require('../../adapters/claude/adapter');
const { FakeTransport } = require('../fixtures/fake-transport');

const ownedTmpDirs = new Set();

function tmpDir() {
  const d = path.join(os.tmpdir(), `dcli-parity-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  ownedTmpDirs.add(d);
  return d;
}

function cleanAll() {
  for (const d of ownedTmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  ownedTmpDirs.clear();
}

function teardown(adapter) {
  if (adapter._childProcess) {
    try { adapter._childProcess.kill(); } catch {}
  }
  try { adapter.Dispose({}); } catch {}
}

async function main() {

// ===========================================================================
// 0. The parser's accepted set is exactly the two contract values
//    (design-spec §16). Derivation is from cli-args; this anchor only guards
//    the gate itself against silently shrinking coverage.
// ===========================================================================
{
  assert.ok(Array.isArray(ACCESS_VALUES), 'parser must export its accepted access set');
  assert.deepStrictEqual([...ACCESS_VALUES].sort(), ['read-only', 'workspace'],
    'parser accepted set must match the contract');
  console.log('PASS: parser accepted set anchors on the contract');
}

// ===========================================================================
// 1. opencode: every accepted value builds the contract ruleset; any value
//    outside the set is rejected, never silently granted a ruleset
// ===========================================================================
{
  const dir = tmpDir();
  for (const access of ACCESS_VALUES) {
    const adapter = new OpencodeAdapter({ transport: new FakeTransport({}) });
    adapter.ValidateRequest({ canonicalDir: dir, access });
    adapter.PrepareInvocation({}, { canonicalDir: dir, access });

    const rules = adapter._lastPermissionRuleset;
    assert.ok(Array.isArray(rules) && rules.length > 0, 'ruleset must be built');

    const star = rules.find(r => r.permission === '*' && r.pattern === '*');
    const edit = rules.find(r => r.permission === 'edit');
    const external = rules.find(r => r.permission === 'external_directory');

    assert.ok(external && external.action === 'deny',
      'no mode may grant access outside the repository/worktree');

    if (access === 'workspace') {
      assert.ok(star && star.action === 'allow', 'workspace = broad allow inside the repo');
      assert.strictEqual(edit, undefined, 'workspace must not deny edit');
    } else {
      assert.ok(!star, 'read-only must not broad-allow');
      assert.ok(edit && edit.action === 'deny', 'read-only must deny edit');
    }
  }

  const adapter = new OpencodeAdapter({ transport: new FakeTransport({}) });
  assert.throws(
    () => adapter.PrepareInvocation({}, { canonicalDir: dir, access: 'full' }),
    /read-only.*workspace|Unknown access/,
    'an out-of-contract access value must be rejected'
  );
  console.log('PASS: opencode ruleset parity + out-of-contract rejection');
}

// ===========================================================================
// 2. codex: every accepted value maps to the contract sandbox mode
// ===========================================================================
{
  const saved = process.env.CODEX_PATH;
  process.env.CODEX_PATH = process.env.ComSpec || 'cmd.exe';
  try {
    for (const access of ACCESS_VALUES) {
      const adapter = new CodexAdapter({});
      adapter.ValidateRequest({ canonicalDir: process.cwd(), access });
      await adapter.Start({});
      const argv = (adapter._childProcess.spawnargs || []).join(' ');
      const expected = access === 'workspace'
        ? 'sandbox_mode="workspace-write"'
        : 'sandbox_mode="read-only"';
      assert.ok(argv.includes(expected),
        `codex sandbox for ${access} must be ${expected}; got: ${argv.slice(0, 300)}`);
      teardown(adapter);
    }
  } finally {
    if (saved === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = saved;
  }
  console.log('PASS: codex sandbox parity');
}

// ===========================================================================
// 3. claude: every accepted value maps to the contract permission mode
// ===========================================================================
{
  const saved = process.env.CLAUDE_PATH;
  process.env.CLAUDE_PATH = process.env.ComSpec || 'cmd.exe';
  try {
    for (const access of ACCESS_VALUES) {
      const adapter = new ClaudeAdapter({});
      adapter.ValidateRequest({ canonicalDir: process.cwd(), access });
      await adapter.Start({});
      const argv = (adapter._childProcess.spawnargs || []).join(' ');
      const expected = access === 'workspace'
        ? '--permission-mode acceptEdits'
        : '--permission-mode auto';
      assert.ok(argv.includes(expected),
        `claude permission mode for ${access} must be ${expected}; got: ${argv.slice(0, 300)}`);
      teardown(adapter);
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PATH;
    else process.env.CLAUDE_PATH = saved;
  }
  console.log('PASS: claude permission-mode parity');
}

cleanAll();
}

main().catch(err => {
  console.error('FAIL:', err && err.stack || err);
  process.exit(1);
});
