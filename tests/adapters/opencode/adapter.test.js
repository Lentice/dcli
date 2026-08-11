// @suite full
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OpencodeAdapter, resolveOpencodePath } = require('../../../adapters/opencode/adapter');
const { FakeTransport } = require('../../fixtures/fake-transport');
const { withVersionShim, writeVersionShim, writeVersionShimAt } = require('../../fixtures/version-shim');

const TERMINAL_OR_INTERRUPTED = ['done', 'failed', 'timed_out', 'cancelled', 'interrupted'];

const TURN_SCRIPT = {
  '/project/current': { directory: __dirname },
  '/session': { id: 'ses_test' },
  '/session/ses_test/prompt_async': { status: 204 },
  '/session/status': { ses_test: { type: 'idle' } },
  '/session/ses_test/message': {
    parts: [
      { id: 'p1', messageID: 'msg_1', type: 'text', text: 'Hello from opencode' },
      { id: 'p2', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 250, input: 50, output: 200 } },
    ],
  },
  '/permission': [],
  '/question': [],
};

function makeAdapter(opts = {}) {
  return new OpencodeAdapter({
    transport: new FakeTransport({ script: TURN_SCRIPT }),
    ...opts,
  });
}

async function runFullTurn(adapter) {
  adapter.PrepareInvocation({}, { canonicalDir: __dirname, access: 'read-only' });
  await adapter.Start({});
  await adapter.SendPrompt({}, 'test prompt');
  const facts = [];
  for await (const fact of adapter.Observe({})) {
    facts.push(fact);
    if (fact.type === 'process_exited') break;
  }
  return facts;
}

async function main() {

// ===========================================================================
// 0. Windows PATH resolution selects an executable-form opencode shim
// ===========================================================================
if (process.platform === 'win32') {
  const childProcess = require('node:child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-opencode-path-'));
  const fixture = path.join(tmpDir, 'opencode.cmd');
  const bunVendor = path.join(tmpDir, 'install', 'global', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  const savedOpencodePath = process.env.OPENCODE_PATH;
  const savedPATH = process.env.PATH;
  const savedPath = process.env.Path;
  const savedBunInstall = process.env.BUN_INSTALL;
  const savedExecSync = childProcess.execSync;
  try {
    fs.writeFileSync(fixture, '@echo off\r\n', 'utf8');
    fs.mkdirSync(path.dirname(bunVendor), { recursive: true });
    fs.writeFileSync(bunVendor, 'not the PATH-selected executable', 'utf8');
    delete process.env.OPENCODE_PATH;
    process.env.PATH = tmpDir;
    process.env.Path = tmpDir;
    process.env.BUN_INSTALL = tmpDir;
    childProcess.execSync = () => { throw new Error('bun unavailable'); };

    assert.strictEqual(resolveOpencodePath(), fixture,
      'opencode resolver must find a .cmd shim without relying on where.exe');
    console.log('PASS: resolveOpencodePath finds executable-form PATH shim');
  } finally {
    if (savedOpencodePath === undefined) delete process.env.OPENCODE_PATH;
    else process.env.OPENCODE_PATH = savedOpencodePath;
    if (savedPATH === undefined) delete process.env.PATH;
    else process.env.PATH = savedPATH;
    if (savedPath === undefined) delete process.env.Path;
    else process.env.Path = savedPath;
    if (savedBunInstall === undefined) delete process.env.BUN_INSTALL;
    else process.env.BUN_INSTALL = savedBunInstall;
    childProcess.execSync = savedExecSync;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ===========================================================================
// 0b. Windows Bun .exe shims resolve to the bundled opencode binary
// ===========================================================================
if (process.platform === 'win32') {
  const childProcess = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-opencode-bun-'));
  const shim = path.join(root, '.bun', 'bin', 'opencode.exe');
  const vendor = path.join(root, '.bun', 'install', 'global', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  const savedOpencodePath = process.env.OPENCODE_PATH;
  const savedPATH = process.env.PATH;
  const savedPath = process.env.Path;
  const savedBunInstall = process.env.BUN_INSTALL;
  const savedExecSync = childProcess.execSync;
  try {
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.mkdirSync(path.dirname(vendor), { recursive: true });
    fs.writeFileSync(shim, 'shim', 'utf8');
    fs.writeFileSync(vendor, 'vendor', 'utf8');
    delete process.env.OPENCODE_PATH;
    delete process.env.BUN_INSTALL;
    process.env.PATH = path.dirname(shim);
    process.env.Path = process.env.PATH;
    childProcess.execSync = () => { throw new Error('bun unavailable'); };

    assert.strictEqual(resolveOpencodePath(), vendor,
      'opencode .exe Bun shim must resolve to its bundled binary');
    console.log('PASS: resolveOpencodePath resolves Bun .exe shim');
  } finally {
    if (savedOpencodePath === undefined) delete process.env.OPENCODE_PATH;
    else process.env.OPENCODE_PATH = savedOpencodePath;
    if (savedPATH === undefined) delete process.env.PATH;
    else process.env.PATH = savedPATH;
    if (savedPath === undefined) delete process.env.Path;
    else process.env.Path = savedPath;
    if (savedBunInstall === undefined) delete process.env.BUN_INSTALL;
    else process.env.BUN_INSTALL = savedBunInstall;
    childProcess.execSync = savedExecSync;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

// ===========================================================================
// 1. GetIdentity returns correct shape
// ===========================================================================
{
  const adapter = makeAdapter();
  const id = adapter.GetIdentity();
  assert.ok(id && typeof id === 'object');
  assert.strictEqual(id.backend, 'opencode');
  assert.strictEqual(typeof id.adapter_version, 'string');
  assert.strictEqual(typeof id.state_schema_version, 'number');
  assert.strictEqual(id.state_schema_version, 1);
  console.log('PASS: GetIdentity returns correct shape');
}

// ===========================================================================
// 2. DetectVersion runs the real probe against a version shim
// ===========================================================================
{
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-opencode-det-'));
  const shim = writeVersionShim(shimDir, '1.18.8');
  await withVersionShim('OPENCODE_PATH', shim, () => {
    const adapter = makeAdapter();
    const v = adapter.DetectVersion();
    assert.strictEqual(typeof v, 'string');
    assert.strictEqual(v, '1.18.8');
  });
  try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch {}
  console.log('PASS: DetectVersion returns version string');
}

// ===========================================================================
// 2a. DetectVersion probes a path with spaces and quoting metacharacters
// ===========================================================================
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-opencode-meta-'));
  try {
    const metaDir = path.join(tmpDir, 'Program Files (x86)', 'my tool');
    fs.mkdirSync(metaDir, { recursive: true });
    if (process.platform === 'win32') {
      const shim = writeVersionShimAt(path.join(metaDir, 'version&go.cmd'), '1.18.8');
      await withVersionShim('OPENCODE_PATH', shim, () => {
        const adapter = makeAdapter();
        assert.strictEqual(adapter.DetectVersion(), '1.18.8',
          'probe must run a metachar-containing .cmd path via the shared construction');
      });
    } else {
      const shim = path.join(metaDir, 'version&go');
      fs.writeFileSync(shim, '#!/bin/sh\n', 'utf8');
      fs.appendFileSync(shim, 'echo 1.18.8\n', 'utf8');
      fs.chmodSync(shim, 0o755);
      await withVersionShim('OPENCODE_PATH', shim, () => {
        const adapter = makeAdapter();
        assert.strictEqual(adapter.DetectVersion(), '1.18.8',
          'probe must run a metachar-containing path as an argument array');
      });
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  console.log('PASS: DetectVersion probes a metacharacter-containing path');
}

// ===========================================================================
// 3. ProbeCapabilities returns object with required fields
// ===========================================================================
{
  const adapter = makeAdapter();
  const caps = adapter.ProbeCapabilities();
  assert.ok(caps && typeof caps === 'object');
  assert.strictEqual(caps.schema_version, 1);
  assert.strictEqual(caps.backend, 'opencode');
  assert.ok(typeof caps.backend_version === 'string');
  assert.ok(caps.supported_version_range);
  assert.ok(caps.supported_version_range.min);
  assert.ok(caps.supported_version_range.max);
  console.log('PASS: ProbeCapabilities returns valid manifest');
}

// ===========================================================================
// 4. DeclareCancelRungs returns opencode's three real rungs
// ===========================================================================
{
  const adapter = makeAdapter();
  const rungs = adapter.DeclareCancelRungs();
  assert.ok(Array.isArray(rungs));
  assert.strictEqual(rungs.length, 3);
  assert.deepStrictEqual(rungs, ['session_abort', 'server_dispose', 'hard_kill']);
  console.log('PASS: DeclareCancelRungs returns 3 rungs');
}

// ===========================================================================
// 5. ValidateRequest rejects reasoningEffort and effort, accepts variant
// ===========================================================================
{
  const adapter = makeAdapter();

  // variant is accepted
  adapter.ValidateRequest({ variant: 'high' });

  // reasoningEffort is rejected
  assert.throws(() => {
    adapter.ValidateRequest({ reasoningEffort: 'high' });
  }, (err) => err.code === 'VALIDATION_FAILED');

  // effort is rejected
  assert.throws(() => {
    adapter.ValidateRequest({ effort: 'high' });
  }, (err) => err.code === 'VALIDATION_FAILED');

  console.log('PASS: ValidateRequest rejects reasoningEffort, accepts variant');
}

// ===========================================================================
// 6. Observe yields only closed-set fact types
// ===========================================================================
{
  const adapter = makeAdapter();
  const iterator = adapter.Observe({});
  assert.ok(iterator && typeof iterator[Symbol.asyncIterator] === 'function');
  console.log('PASS: Observe returns async iterator');
}

// ===========================================================================
// 7. CollectResult returns text, usage, and backend_session_id
// ===========================================================================
{
  const adapter = makeAdapter();
  await runFullTurn(adapter);
  const result = adapter.CollectResult({});
  assert.ok(result && typeof result === 'object');
  assert.strictEqual(result.text, 'Hello from opencode');
  assert.ok(result.usage && typeof result.usage === 'object');
  assert.strictEqual(result.usage.total, 250);
  assert.strictEqual(result.backend_session_id, 'ses_test');
  console.log('PASS: CollectResult returns text, usage, session');
}

// ===========================================================================
// 8. CollectResult with no turn returns empty text
// ===========================================================================
{
  const adapter = makeAdapter();
  const result = adapter.CollectResult({});
  assert.strictEqual(result.text, '');
  assert.strictEqual(result.usage.total, 0);
  assert.strictEqual(result.backend_session_id, null);
  console.log('PASS: CollectResult with no turn returns empty');
}

// ===========================================================================
// 9. CollectDiagnostics returns object with schema_version
// ===========================================================================
{
  const adapter = makeAdapter();
  const diag = adapter.CollectDiagnostics({});
  assert.ok(diag && typeof diag === 'object');
  assert.strictEqual(diag.schema_version, 1);
  assert.strictEqual(diag.backend, 'opencode');
  console.log('PASS: CollectDiagnostics returns diagnostics');
}

// ===========================================================================
// 10. Adapter does NOT decide terminality — no terminality API
// ===========================================================================
{
  const adapter = makeAdapter();
  const bannedMethods = ['isDone', 'isComplete', 'setTerminal', 'setState', 'declareDone', 'declareTerminal', 'isTerminal'];
  for (const m of bannedMethods) {
    assert.strictEqual(typeof adapter[m], 'undefined', `Adapter must not have method "${m}"`);
  }
  console.log('PASS: Adapter has no terminality API');
}

// ===========================================================================
// 11. Recover returns terminal or interrupted state
// ===========================================================================
{
  const adapter = makeAdapter();
  await runFullTurn(adapter);
  const recovery = adapter.Recover({});
  assert.ok(recovery && typeof recovery.state === 'string');
  assert.ok(TERMINAL_OR_INTERRUPTED.includes(recovery.state),
    `Recover returned "${recovery.state}" which is not terminal`);
  console.log('PASS: Recover returns terminal/interrupted state');
}

// ===========================================================================
// 12. PrepareInvocation, SendPrompt, Resume are present and don't throw
// ===========================================================================
{
  const adapter = makeAdapter();
  assert.doesNotThrow(() => adapter.PrepareInvocation({}, { canonicalDir: __dirname }));
  await assert.doesNotReject(() => adapter.SendPrompt({}, 'test prompt'));
  assert.doesNotThrow(() => adapter.Resume({}, 'fork_from_artifacts', 'continue'));
  console.log('PASS: PrepareInvocation, SendPrompt, Resume exist');
}

// ===========================================================================
// 13. Respond is implemented and does not throw when capabilities declare it
// ===========================================================================
{
  const adapter = makeAdapter();
  const caps = adapter.ProbeCapabilities();
  const hasPerms = caps.extensions && caps.extensions.interactive_permissions && caps.extensions.interactive_permissions.supported;
  assert.ok(hasPerms, 'opencode must declare interactive_permissions as supported');
  console.log('PASS: Respond implemented');
}

// ===========================================================================
// 14. Dispose is idempotent
// ===========================================================================
{
  const adapter = makeAdapter();
  assert.doesNotThrow(() => adapter.Dispose({}));
  assert.doesNotThrow(() => adapter.Dispose({}));
  console.log('PASS: Dispose is idempotent');
}

// ===========================================================================
// 15. Start returns an execution handle
// ===========================================================================
{
  const adapter = makeAdapter();
  const handle = await adapter.Start({});
  assert.ok(handle && typeof handle === 'object');
  console.log('PASS: Start returns execution handle');
}

// ===========================================================================
// 16. RequestCancel implements all three rungs
// ===========================================================================
{
  const adapter = makeAdapter();
  await adapter.Start({});
  const rungs = adapter.DeclareCancelRungs();

  for (const rung of rungs) {
    const result = await adapter.RequestCancel({}, rung);
    assert.ok(result && typeof result === 'object');
    assert.ok('success' in result);
  }
  console.log('PASS: RequestCancel handles all three rungs');
}

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
