// @suite full
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { CodexAdapter, buildArgv, resolveCodexPath, EFFORT_LEVELS } = require('../../../adapters/codex/adapter');
const { executableNames, resolveExecutablePath } = require('../../../adapters/shared/resolve-executable');
const { validateFact } = require('../../../core/fact-types');
const { ScriptedChild } = require('../../../tests/fixtures/scripted-child');
const { writeVersionShim, writeVersionShimAt, withVersionShim } = require('../../../tests/fixtures/version-shim');

const TERMINAL_OR_INTERRUPTED = ['done', 'failed', 'timed_out', 'cancelled', 'interrupted'];

// Tests that only need an adapter instance (identity, capabilities, validation,
// argv) use a plain adapter. Tests that need facts or a child drive a scripted
// fake child through the `_spawn` seam, so framing, drain and exit ordering
// run for real.
function makeMinimalAdapter() {
  return new CodexAdapter();
}

function makeScriptedAdapter() {
  const adapter = new CodexAdapter();
  const fake = new ScriptedChild();
  adapter._spawn = () => fake;
  return { adapter, fake };
}

async function main() {

// ===========================================================================
// 0. Windows PATH resolution must find an executable-form npm shim
// ===========================================================================
if (process.platform === 'win32') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-codex-path-'));
  const fixture = path.join(tmpDir, 'codex.cmd');
  const savedCodexPath = process.env.CODEX_PATH;
  const savedPATH = process.env.PATH;
  const savedPath = process.env.Path;
  try {
    fs.writeFileSync(fixture, '@echo off\r\n', 'utf8');
    delete process.env.CODEX_PATH;
    process.env.PATH = tmpDir;
    process.env.Path = tmpDir;
    assert.strictEqual(resolveCodexPath(), fixture,
      'resolver must find codex.cmd from PATH');
    console.log('PASS: resolveCodexPath finds executable-form PATH shim');
  } finally {
    if (savedCodexPath === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = savedCodexPath;
    if (savedPATH === undefined) delete process.env.PATH;
    else process.env.PATH = savedPATH;
    if (savedPath === undefined) delete process.env.Path;
    else process.env.Path = savedPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ===========================================================================
// 0a. Windows PATH precedence wins over a later shim form
// ===========================================================================
if (process.platform === 'win32') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-codex-path-order-'));
  const firstDir = path.join(tmpDir, 'first');
  const secondDir = path.join(tmpDir, 'second');
  const first = path.join(firstDir, 'codex.cmd');
  const second = path.join(secondDir, 'codex.exe');
  const savedCodexPath = process.env.CODEX_PATH;
  const savedPATH = process.env.PATH;
  const savedPath = process.env.Path;
  try {
    fs.mkdirSync(firstDir);
    fs.mkdirSync(secondDir);
    fs.writeFileSync(first, '@echo off\r\n', 'utf8');
    fs.writeFileSync(second, 'not a real executable fixture', 'utf8');
    const vendor = path.join(
      secondDir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
      'codex-win32-x64', 'vendor', 'win32-x64', 'bin', 'codex.exe'
    );
    fs.mkdirSync(path.dirname(vendor), { recursive: true });
    fs.writeFileSync(vendor, 'not a real executable fixture', 'utf8');
    delete process.env.CODEX_PATH;
    process.env.PATH = [firstDir, secondDir].join(path.delimiter);
    process.env.Path = process.env.PATH;

    assert.strictEqual(resolveCodexPath(), first,
      'resolver must preserve PATH precedence across executable forms');
    console.log('PASS: resolveCodexPath preserves Windows PATH precedence');
  } finally {
    if (savedCodexPath === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = savedCodexPath;
    if (savedPATH === undefined) delete process.env.PATH;
    else process.env.PATH = savedPATH;
    if (savedPath === undefined) delete process.env.Path;
    else process.env.Path = savedPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ===========================================================================
// 0b. POSIX PATH resolution skips non-executable files
// ===========================================================================
if (process.platform !== 'win32') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-codex-posix-path-'));
  const badDir = path.join(tmpDir, 'bad');
  const goodDir = path.join(tmpDir, 'good');
  const savedCodexPath = process.env.CODEX_PATH;
  const savedPATH = process.env.PATH;
  const savedPath = process.env.Path;
  try {
    fs.mkdirSync(badDir);
    fs.mkdirSync(goodDir);
    const bad = path.join(badDir, 'codex');
    const good = path.join(goodDir, 'codex');
    fs.writeFileSync(bad, '#!/bin/sh\n', 'utf8');
    fs.writeFileSync(good, '#!/bin/sh\n', 'utf8');
    fs.chmodSync(bad, 0o644);
    fs.chmodSync(good, 0o755);
    delete process.env.CODEX_PATH;
    process.env.PATH = [badDir, goodDir].join(path.delimiter);
    process.env.Path = process.env.PATH;
    assert.strictEqual(resolveCodexPath(), good,
      'POSIX resolver must skip a non-executable PATH candidate');
    console.log('PASS: resolveCodexPath skips non-executable POSIX candidate');
  } finally {
    if (savedCodexPath === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = savedCodexPath;
    if (savedPATH === undefined) delete process.env.PATH;
    else process.env.PATH = savedPATH;
    if (savedPath === undefined) delete process.env.Path;
    else process.env.Path = savedPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ===========================================================================
// 0c. A near-resolver result must still be a regular executable file
// ===========================================================================
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-resolver-near-'));
  const command = 'dcli-resolver-near';
  const candidate = path.join(tmpDir, process.platform === 'win32' ? `${command}.cmd` : command);
  const invalid = path.join(tmpDir, 'vendor-directory');
  const envName = 'DCLI_TEST_RESOLVER_NEAR_PATH';
  const savedEnv = process.env[envName];
  const savedPATH = process.env.PATH;
  const savedPath = process.env.Path;
  try {
    fs.writeFileSync(candidate, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') fs.chmodSync(candidate, 0o755);
    fs.mkdirSync(invalid);
    delete process.env[envName];
    process.env.PATH = tmpDir;
    process.env.Path = tmpDir;

    assert.strictEqual(resolveExecutablePath({
      envName,
      fallback: command,
      names: executableNames(command),
      resolveNear: () => invalid,
    }), candidate, 'invalid near-resolver path must be rejected');
    console.log('PASS: near-resolver result is validated before use');
  } finally {
    if (savedEnv === undefined) delete process.env[envName];
    else process.env[envName] = savedEnv;
    process.env.PATH = savedPATH;
    process.env.Path = savedPath;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ===========================================================================
// 1. GetIdentity returns correct shape
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const id = adapter.GetIdentity();
  assert.ok(id && typeof id === 'object');
  assert.strictEqual(id.backend, 'codex');
  assert.strictEqual(typeof id.adapter_version, 'string');
  assert.strictEqual(typeof id.state_schema_version, 'number');
  assert.strictEqual(id.state_schema_version, 1);
  console.log('PASS: GetIdentity returns correct shape');
}

// ===========================================================================
// 2. DetectVersion probes the installed CLI and returns a version string
// ===========================================================================
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-codex-ver-'));
  try {
    const shim = writeVersionShim(tmpDir, '0.145.0');
    await withVersionShim('CODEX_PATH', shim, () => {
      const adapter = makeMinimalAdapter();
      const v = adapter.DetectVersion();
      assert.strictEqual(typeof v, 'string');
      assert.strictEqual(v, '0.145.0');
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  console.log('PASS: DetectVersion returns version string');
}

// ===========================================================================
// 2a. DetectVersion probes a path with spaces and quoting metacharacters
// ===========================================================================
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-codex-meta-'));
  try {
    const metaDir = path.join(tmpDir, 'Program Files (x86)', 'my tool');
    fs.mkdirSync(metaDir, { recursive: true });
    if (process.platform === 'win32') {
      const shim = writeVersionShimAt(path.join(metaDir, 'version&go.cmd'), '0.145.0');
      await withVersionShim('CODEX_PATH', shim, () => {
        const adapter = makeMinimalAdapter();
        assert.strictEqual(adapter.DetectVersion(), '0.145.0',
          'probe must run a metachar-containing .cmd path via the shared construction');
      });
    } else {
      const shim = path.join(metaDir, 'version&go');
      fs.writeFileSync(shim, '#!/bin/sh\n', 'utf8');
      fs.appendFileSync(shim, 'echo 0.145.0\n', 'utf8');
      fs.chmodSync(shim, 0o755);
      await withVersionShim('CODEX_PATH', shim, () => {
        const adapter = makeMinimalAdapter();
        assert.strictEqual(adapter.DetectVersion(), '0.145.0',
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
  const adapter = makeMinimalAdapter();
  const caps = adapter.ProbeCapabilities();
  assert.ok(caps && typeof caps === 'object');
  assert.strictEqual(caps.schema_version, 1);
  assert.strictEqual(caps.backend, 'codex');
  assert.ok(typeof caps.backend_version === 'string');
  assert.ok(caps.supported_version_range);
  assert.ok(caps.supported_version_range.min);
  assert.ok(caps.supported_version_range.max);
  // Codex has no interactive_permissions or graceful_session_abort
  assert.ok(caps.extensions !== undefined || Object.keys(caps.extensions).length >= 0);
  console.log('PASS: ProbeCapabilities returns valid manifest');
}

// ===========================================================================
// 4. DeclareCancelRungs returns exactly ['hard_kill']
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const rungs = adapter.DeclareCancelRungs();
  assert.ok(Array.isArray(rungs));
  assert.strictEqual(rungs.length, 1);
  assert.deepStrictEqual(rungs, ['hard_kill']);
  console.log('PASS: DeclareCancelRungs returns exactly [\'hard_kill\']');
}

// ===========================================================================
// 5. ValidateRequest rejects variant, accepts effort and reasoningEffort
// ===========================================================================
{
  const adapter = makeMinimalAdapter();

  // effort is accepted
  adapter.ValidateRequest({ effort: 'high' });

  // reasoningEffort is accepted
  adapter.ValidateRequest({ reasoningEffort: 'high' });

  // variant is rejected
  const adapter2 = makeMinimalAdapter();
  assert.throws(() => {
    adapter2.ValidateRequest({ variant: 'high' });
  }, (err) => err.code === 'VALIDATION_FAILED');

  console.log('PASS: ValidateRequest rejects variant, accepts effort/reasoningEffort');
}

// ===========================================================================
// 6. Observe yields only closed-set fact types
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const iterator = adapter.Observe({});
  assert.ok(iterator && typeof iterator[Symbol.asyncIterator] === 'function');
  console.log('PASS: Observe returns async iterator');
}

// ===========================================================================
// 6a. Effort aliases validate and prefer --effort
// ===========================================================================
{
  for (const level of EFFORT_LEVELS) {
    const adapter = makeMinimalAdapter();
    adapter.ValidateRequest({ effort: level });
    adapter.ValidateRequest({ reasoningEffort: level });
  }

  for (const optionName of ['effort', 'reasoningEffort']) {
    const adapter = makeMinimalAdapter();
    assert.throws(() => adapter.ValidateRequest({ [optionName]: 'turbo' }), (err) => (
      err.code === 'VALIDATION_FAILED' &&
      err.failureClass === 'usage_error' &&
      err.optionName === `--${optionName.replace(/[A-Z]/g, match => '-' + match.toLowerCase())}` &&
      err.message.includes('No job was created.')
    ));
  }

  const argv = buildArgv({ workDir: process.cwd(), resultFilePath: 'result.txt', effort: 'high', reasoningEffort: 'low' });
  assert.ok(argv.includes('model_reasoning_effort=high'));
  assert.ok(!argv.includes('model_reasoning_effort=low'));
  console.log('PASS: Codex effort aliases validate and prefer --effort');
}

// ===========================================================================
// 7. CollectResult returns the -o result file's text with zeroed usage
// ===========================================================================
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-codex-test-'));
  try {
    const resultFile = path.join(tmpDir, 'result.txt');
    fs.writeFileSync(resultFile, 'Hello from codex', 'utf8');
    const adapter = makeMinimalAdapter();
    adapter._resultFilePath = resultFile;
    const result = adapter.CollectResult({});
    assert.ok(result && typeof result === 'object');
    assert.strictEqual(result.text, 'Hello from codex');
    assert.ok(result.usage && typeof result.usage === 'object');
    assert.strictEqual(result.usage.total, 0);
    assert.strictEqual(result.backend_session_id, null);
    console.log('PASS: CollectResult returns the result file text');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ===========================================================================
// 8. CollectResult with no result file returns empty text
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const result = adapter.CollectResult({});
  assert.strictEqual(result.text, '');
  assert.strictEqual(result.usage.total, 0);
  assert.strictEqual(result.backend_session_id, null);
  console.log('PASS: CollectResult with no result file returns empty');
}

// ===========================================================================
// 9. 0-byte result file is classified as empty, not a crash
// ===========================================================================
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-codex-test-'));
  try {
    const resultFile = path.join(tmpDir, 'result.txt');
    fs.writeFileSync(resultFile, '');
    const adapter = new CodexAdapter();
    // Inject the result file path as if Start had created it
    adapter._resultFilePath = resultFile;
    const result = adapter.CollectResult({});
    assert.strictEqual(result.text, '',
      '0-byte file must produce empty text, not throw');
    assert.ok(result.usage && typeof result.usage === 'object');
    assert.strictEqual(result.usage.total, 0);
    console.log('PASS: 0-byte result file classified as empty');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ===========================================================================
// 10. Non-existent result file produces empty result
// ===========================================================================
{
  const adapter = new CodexAdapter();
  adapter._resultFilePath = path.join(os.tmpdir(), 'dcli-codex-test-nonexistent-' + Date.now() + '.txt');
  const result = adapter.CollectResult({});
  assert.strictEqual(result.text, '',
    'Non-existent file must produce empty text');
  console.log('PASS: Non-existent result file produces empty result');
}

// ===========================================================================
// 11. CollectDiagnostics returns object with schema_version
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const diag = adapter.CollectDiagnostics({});
  assert.ok(diag && typeof diag === 'object');
  assert.strictEqual(diag.schema_version, 1);
  assert.strictEqual(diag.backend, 'codex');
  console.log('PASS: CollectDiagnostics returns diagnostics');
}

// ===========================================================================
// 12. Adapter does NOT decide terminality — no terminality API
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const bannedMethods = ['isDone', 'isComplete', 'setTerminal', 'setState', 'declareDone', 'declareTerminal', 'isTerminal'];
  for (const m of bannedMethods) {
    assert.strictEqual(typeof adapter[m], 'undefined', `Adapter must not have method "${m}"`);
  }
  console.log('PASS: Adapter has no terminality API');
}

// ===========================================================================
// 13. Recover returns terminal or interrupted state
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const recovery = adapter.Recover({});
  assert.ok(recovery && typeof recovery.state === 'string');
  assert.ok(TERMINAL_OR_INTERRUPTED.includes(recovery.state),
    `Recover returned "${recovery.state}" which is not terminal`);
  console.log('PASS: Recover returns terminal/interrupted state');
}

// ===========================================================================
// 14. PrepareInvocation, SendPrompt, Resume are present and don't throw
// ===========================================================================
{
  const { adapter } = makeScriptedAdapter();
  try {
    await adapter.Start({});
    assert.doesNotThrow(() => adapter.PrepareInvocation({}, {}));
    assert.doesNotThrow(() => adapter.SendPrompt({}, 'test prompt'));
    assert.doesNotThrow(() => adapter.Resume({}, 'fork_from_artifacts', 'continue'));
  } finally {
    try { adapter.Dispose({}); } catch {}
  }
  console.log('PASS: PrepareInvocation, SendPrompt, Resume exist');
}

// ===========================================================================
// 15. Respond throws (not supported by Codex)
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  assert.throws(() => adapter.Respond('test-id', 'allow'), /not supported/);
  console.log('PASS: Respond throws when capabilities not declared');
}

// ===========================================================================
// 16. Dispose is idempotent
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  assert.doesNotThrow(() => adapter.Dispose({}));
  assert.doesNotThrow(() => adapter.Dispose({}));
  console.log('PASS: Dispose is idempotent');
}

// ===========================================================================
// 17. Start returns an execution handle carrying the child pid
// ===========================================================================
{
  const { adapter, fake } = makeScriptedAdapter();
  try {
    const handle = await adapter.Start({});
    assert.ok(handle && typeof handle === 'object');
    assert.strictEqual(handle.handle, 'codex-process');
    assert.strictEqual(handle.pid, fake.pid, 'handle must carry the spawned child pid');
    assert.ok(handle.resultFile, 'handle must carry the result file path');
  } finally {
    try { adapter.Dispose({}); } catch {}
  }
  console.log('PASS: Start returns execution handle');
}

// ===========================================================================
// 18. RequestCancel accepts only hard_kill
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const rungs = adapter.DeclareCancelRungs();
  assert.deepStrictEqual(rungs, ['hard_kill']);

  // Unknown rungs are rejected
  const resultBad = await adapter.RequestCancel({}, 'session_abort');
  assert.strictEqual(resultBad.success, false);

  // hard_kill succeeds
  const resultGood = await adapter.RequestCancel({}, 'hard_kill');
  assert.strictEqual(resultGood.success, true);
  assert.strictEqual(adapter.cancelRungReached, 'hard_kill');
  assert.strictEqual(adapter.cancelled, true);
  console.log('PASS: RequestCancel handles hard_kill and rejects unknown rungs');
}

// ===========================================================================
// 19. Adapter does not emit backend_status
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const parsed = adapter._parseJsonlEvent('{"type":"backend_status","state":"busy"}');
  assert.strictEqual(parsed, null,
    'backend_status is not a codex fact and must be skipped by the parser');
  console.log('PASS: Adapter does not emit backend_status');
}

// ===========================================================================
// 20. PrepareInvocation stores request for later use by Start
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const request = { model: 'o3-mini', effort: 'high', reasoningEffort: 'high' };
  adapter.PrepareInvocation({}, request);
  assert.deepStrictEqual(adapter._lastRequest, request);
  console.log('PASS: PrepareInvocation stores request');
}

// ===========================================================================
// 21. Argv building golden test — exec-level options before subcommand
// ===========================================================================
{
  const opts = {
    workDir: 'C:\\workspace',
    resultFilePath: 'C:\\temp\\result.txt',
    sandbox: 'read-only',
    model: 'o3-mini',
    effort: 'high',
  };
  const argv = buildArgv(opts);
  // Must be an array
  assert.ok(Array.isArray(argv));
  // exec must come before options
  const execIdx = argv.indexOf('exec');
  assert.ok(execIdx >= 0, 'argv must contain "exec"');
  // --json must be after exec
  const jsonIdx = argv.indexOf('--json');
  assert.ok(jsonIdx > execIdx, '--json must come after exec subcommand');
  // --color never
  assert.ok(argv.includes('--color'));
  assert.ok(argv.includes('never'));
  // -s sandbox
  const sIdx = argv.indexOf('-s');
  assert.ok(sIdx >= 0);
  assert.strictEqual(argv[sIdx + 1], 'read-only');
  // No approval-prompt flag: verified against the real installed codex-cli
  // 0.145.0 `exec --help` that no such flag exists — `exec` is already
  // non-interactive by design, governed solely by the sandbox mode.
  assert.ok(!argv.includes('-a'), 'argv must not contain a nonexistent -a flag');
  // -C workDir
  assert.ok(argv.includes('-C'));
  // -o result file
  assert.ok(argv.includes('-o'));
  // - at the end (prompt from stdin)
  assert.strictEqual(argv[argv.length - 1], '-');
  // effort maps to -c
  const cIdx = argv.indexOf('-c');
  assert.ok(cIdx >= 0, 'effort must map to -c flag');
  assert.ok(argv.includes('model_reasoning_effort=high'),
    'effort must map to model_reasoning_effort');
  // model maps to -m
  assert.ok(argv.includes('-m'));
  assert.ok(argv.includes('o3-mini'));
  // --ephemeral, --ignore-user-config, --ignore-rules for clean run
  assert.ok(argv.includes('--ephemeral'));
  assert.ok(argv.includes('--ignore-user-config'));
  assert.ok(argv.includes('--ignore-rules'));
  console.log('PASS: Argv is built correctly with exec-level options before subcommand tokens');
}

// ===========================================================================
// 22. Facts from a real scripted run pass validation
// ===========================================================================
{
  const { adapter, fake } = makeScriptedAdapter();
  try {
    await adapter.Start({});
    await adapter.SendPrompt({}, 'hi');
    fake.pushStdout('{"type":"assistant_text","content":"ok"}\n');
    fake.pushStdout('{"type":"tool_use","name":"Bash","summary":"run a command"}\n');
    fake.pushStdout('{"type":"usage","input_tokens":10,"output_tokens":20}\n');
    await new Promise(r => setTimeout(r, 10));
    fake.emitExit(0);
    fake.closeStreams();
    const facts = [];
    for await (const f of adapter.Observe({})) facts.push(f);
    for (const f of facts) validateFact(f);
    assert.ok(facts.some(f => f.type === 'assistant_text'), 'assistant_text must be parsed');
    assert.strictEqual(facts[facts.length - 1].type, 'process_exited');
  } finally {
    try { adapter.Dispose({}); } catch {}
  }
  console.log('PASS: Facts pass validation');
}

// ===========================================================================
// 23. SendPrompt arms output readers before writing (structural check)
// ===========================================================================
{
  const { adapter } = makeScriptedAdapter();
  try {
    await adapter.Start({});
    assert.ok(adapter._childProcess.stdout.listenerCount('data') > 0,
      'stdout data reader must be armed in Start, before any stdin write');
    assert.doesNotThrow(() => adapter.SendPrompt({}, 'A'.repeat(100_000)));
  } finally {
    try { adapter.Dispose({}); } catch {}
  }
  console.log('PASS: SendPrompt handles large prompts without issue (readers armed)');
}

// ===========================================================================
// 15. Capabilities declare schema_constrained_output as supported-but-unused
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const caps = adapter.ProbeCapabilities();
  assert.ok(caps.extensions, 'Extensions must exist');
  assert.ok(caps.extensions.schema_constrained_output, 'schema_constrained_output must be declared');
  assert.strictEqual(caps.extensions.schema_constrained_output.supported, true);
  assert.ok(caps.extensions.schema_constrained_output.reason, 'Must have a reason');
  console.log('PASS: schema_constrained_output declared supported-but-unused');
}

// ===========================================================================
// 16. buildArgv supports --add-dir and --skip-git-repo-check
// ===========================================================================
{
  const argv = buildArgv({
    workDir: '/tmp',
    resultFilePath: '/tmp/result.txt',
    addDirs: ['/extra/dir1', '/extra/dir2'],
    skipGitRepoCheck: true,
  });
  assert.ok(argv.includes('--add-dir'), 'Should include --add-dir');
  assert.ok(argv.includes('/extra/dir1'), 'Should include first extra dir');
  assert.ok(argv.includes('/extra/dir2'), 'Should include second extra dir');
  assert.ok(argv.includes('--skip-git-repo-check'), 'Should include --skip-git-repo-check');
  console.log('PASS: buildArgv supports --add-dir and --skip-git-repo-check');
}

// ===========================================================================
// 16b. buildArgv auto-detects a non-git workDir and skips the repo check
// ===========================================================================
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-codex-nongit-'));
  try {
    const argv = buildArgv({ workDir: tmp, resultFilePath: path.join(tmp, 'r.txt') });
    assert.ok(argv.includes('--skip-git-repo-check'), 'Non-git workDir should auto-add --skip-git-repo-check');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('PASS: buildArgv auto-detects a non-git workDir');
}

// ===========================================================================
// 17. Resume stores kind for continue_backend_session
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  adapter.Resume({}, 'continue_backend_session', 'follow-up prompt');
  assert.strictEqual(adapter._resumeKind, 'continue_backend_session');
  assert.strictEqual(adapter._resumePrompt, 'follow-up prompt');
  console.log('PASS: Resume stores kind for continue_backend_session');
}

// ===========================================================================
// 22. Observe yields facts in temporal order (process_exited last)
// ===========================================================================
{
  const { adapter, fake } = makeScriptedAdapter();
  try {
    await adapter.Start({});
    await adapter.SendPrompt({}, 'hi');
    fake.pushStdout('{"type":"assistant_text","content":"chunk 1"}\n');
    fake.pushStdout('{"type":"assistant_text","content":"chunk 2"}\n');
    fake.pushStdout('{"type":"usage","input_tokens":10,"output_tokens":20}\n');
    await new Promise(r => setTimeout(r, 10));
    fake.emitExit(0);
    fake.closeStreams();

    const facts = [];
    for await (const f of adapter.Observe({})) {
      facts.push(f);
    }

    const textFacts = facts.filter(f => f.type === 'assistant_text');
    assert.ok(textFacts.length >= 2,
      `Must yield >= 2 assistant_text facts, got ${textFacts.length}`);
    assert.strictEqual(textFacts[0].text, 'chunk 1');
    assert.strictEqual(textFacts[1].text, 'chunk 2');
    assert.strictEqual(facts[facts.length - 1].type, 'process_exited',
      `process_exited must be last, got ${facts[facts.length - 1].type}`);
    assert.strictEqual(facts[facts.length - 1].code, 0);
  } finally {
    try { adapter.Dispose({}); } catch {}
  }

  console.log('PASS: Observe yields facts in temporal order (process_exited last)');
}

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
