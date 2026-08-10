// @suite full
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runContractSuite } = require('./suite');
const { FakeAdapter } = require('../../adapters/fake/adapter');
const { OpencodeAdapter } = require('../../adapters/opencode/adapter');
const { CodexAdapter } = require('../../adapters/codex/adapter');
const { FakeTransport } = require('../../tests/fixtures/fake-transport');
const { writeVersionShim } = require('../../tests/fixtures/version-shim');

// ===========================================================================
// 1. Parity suite — identical contract over all three adapters
// ===========================================================================

const makeFake = () => new FakeAdapter({
  facts: [
    { type: 'started', backend_pid: 42, backend_session_id: 'ses_contract' },
    { type: 'assistant_text', message_id: 'msg_1', text: 'Contract test result' },
    { type: 'usage_reported', tokens: { input: 50, output: 200, total: 250 } },
    { type: 'process_exited', code: 0 },
  ],
  exitCode: 0,
  declaredRungs: ['hard_kill'],
  capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
});

const makeOpencode = () => new OpencodeAdapter({
  transport: new FakeTransport({
    script: {
      '/permission/test-id/reply': true,
    },
  }),
});

const makeCodex = () => new CodexAdapter();

console.log('--- Contract parity suite ---');
// DetectVersion runs the backend's --version probe for real; point OPENCODE_PATH
// and CODEX_PATH at version-printing fixtures so the parity gate needs no live
// backend. One shim serves both (each probe only runs its own env var).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-parity-codex-'));
const shim = writeVersionShim(tmpDir, '0.145.0');
const savedCodexPath = process.env.CODEX_PATH;
const savedOpencodePath = process.env.OPENCODE_PATH;
process.env.CODEX_PATH = shim;
process.env.OPENCODE_PATH = shim;
let results;
try {
  results = [
    runContractSuite(makeFake, 'fake'),
    runContractSuite(makeOpencode, 'opencode'),
    runContractSuite(makeCodex, 'codex'),
  ];
} finally {
  if (savedCodexPath === undefined) delete process.env.CODEX_PATH;
  else process.env.CODEX_PATH = savedCodexPath;
  if (savedOpencodePath === undefined) delete process.env.OPENCODE_PATH;
  else process.env.OPENCODE_PATH = savedOpencodePath;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}
console.log('---');

// All three must pass
let anyFailed = false;
for (const r of results) {
  if (r.failed > 0) {
    console.error(`  ${r.label}: ${r.failed} assertion(s) failed — gate failure`);
    anyFailed = true;
  }
}
if (anyFailed) {
  process.exit(1);
}

// All three must have the exact same pass count
assert.strictEqual(
  results[0].passed, results[1].passed,
  `Pass count mismatch: fake=${results[0].passed}, opencode=${results[1].passed}`);
assert.strictEqual(
  results[1].passed, results[2].passed,
  `Pass count mismatch: opencode=${results[1].passed}, codex=${results[2].passed}`);

console.log(`All three adapters passed the same ${results[0].passed} assertions.`);

// ===========================================================================
// 2. Suite source must contain no adapter-name branching
// ===========================================================================

{
  const suiteSource = fs.readFileSync(path.join(__dirname, 'suite.js'), 'utf8');
  const adapterNames = ['opencode', 'codex', 'claude', 'fake'];
  const lines = suiteSource.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const name of adapterNames) {
      const regex = new RegExp('\\b' + name + '\\b', 'i');
      if (regex.test(line)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        assert.fail(
          `Suite source must not contain backend name "${name}" outside comments ` +
          `(suite.js:${i + 1}: "${trimmed}")`
        );
      }
    }
  }
  console.log('Suite source is free of adapter-name branching.');
}

// ===========================================================================
// 3. Verify adapter-specific contract asymmetries
// ===========================================================================

// 3a. Codex must not declare interactive_permissions capability
{
  const caps = makeCodex().ProbeCapabilities();
  assert.strictEqual(
    caps.extensions && caps.extensions.interactive_permissions,
    undefined,
    'Codex must not declare interactive_permissions capability'
  );
  console.log('Codex does not declare interactive_permissions (Respond unsupported).');
}

// 3b. Codex Respond throws not supported
{
  assert.throws(
    () => makeCodex().Respond('id', 'allow'),
    /not supported/,
    'Codex Respond must throw'
  );
  console.log('Codex Respond throws "not supported".');
}

// 3c. Opencode has 3 cancel rungs, codex has 1
{
  assert.strictEqual(makeOpencode().DeclareCancelRungs().length, 3);
  assert.strictEqual(makeCodex().DeclareCancelRungs().length, 1);
  console.log('Cancel rungs: opencode=3, codex=1 (expected asymmetry).');
}

// 3d. Codex must not emit backend_status
{
  const parsed = makeCodex()._parseJsonlEvent('{"type":"backend_status","state":"busy"}');
  assert.strictEqual(parsed, null, 'Codex must not emit backend_status facts');
  console.log('Codex does not emit backend_status facts.');
}

// ===========================================================================
// 4. Static check: no backend name in core/ outside allowlist
// ===========================================================================

{
  const coreDir = path.resolve(__dirname, '..', '..', 'core');
  const backendNames = ['opencode', 'codex', 'claude'];

  // Registry allowlist: files whose only job is mapping a name to an adapter.
  const allowlist = new Set(['commands/worker.js']);

  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const relPath = path.relative(coreDir, full).split(path.sep).join('/');
        if (allowlist.has(relPath)) continue;
        const content = fs.readFileSync(full, 'utf8');
        for (const name of backendNames) {
          if (content.includes(name)) {
            assert.fail(
              `core/${relPath} contains backend name "${name}". ` +
              `If this file is a backend-registry file, add it to the allowlist.`
            );
          }
        }
      }
    }
  }

  scanDir(coreDir);
  console.log('No backend-specific conditional found in core/.');
}

console.log('Parity gate passed — contract is backend-agnostic.');
