const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { FakeAdapter } = require('../../adapters/fake/adapter');
const { executeRead } = require('../../core/commands/read');
const { executeRun } = require('../../core/commands/run');
const { Redactor } = require('../../core/redactor');
const { setRedactor, getRedactor } = require('../../core/fs-text');
const { JobStore } = require('../../core/job-store');

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-result-persistence-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function adapterFor(text) {
  return new FakeAdapter({
    facts: [
      ...(text === '' ? [] : [{ type: 'assistant_text', message_id: 'm1', text }]),
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });
}

async function main() {
  await withTempDir(async (dir) => {
    const store = new JobStore({ stateRoot: dir });
    const text = 'pong \u{1F680}';
    const output = await executeRun({
      store, adapter: adapterFor(text), repoKey: 'persisted-result', prompt: 'test prompt', hardTimeoutSec: 60,
    });
    const status = store.readStatus({ repoKey: 'persisted-result', jobId: output.jobId });
    const resultPath = path.join(store.getJobDir('persisted-result', output.jobId), 'attempts', '1', 'result.md');
    assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), text);
    assert.strictEqual(status.result_bytes, Buffer.byteLength(text, 'utf8'));
    const reread = await executeRead({ store, repoKey: 'persisted-result', jobId: output.jobId });
    assert.strictEqual(reread.text, text);
  });
  console.log('PASS: persisted results are byte-accurate and readable');

  await withTempDir(async (dir) => {
    const originalRedactor = getRedactor();
    const redactor = new Redactor();
    redactor.registerSecret('test', 'raw-secret');
    setRedactor(redactor);
    try {
      const store = new JobStore({ stateRoot: dir });
      const output = await executeRun({
        store, adapter: adapterFor('raw-secret'), repoKey: 'redacted-result', prompt: 'test prompt', hardTimeoutSec: 60,
      });
      const resultPath = path.join(store.getJobDir('redacted-result', output.jobId), 'attempts', '1', 'result.md');
      const persisted = fs.readFileSync(resultPath, 'utf8');
      const status = store.readStatus({ repoKey: 'redacted-result', jobId: output.jobId });
      assert.strictEqual(status.result_bytes, Buffer.byteLength(persisted, 'utf8'));
    } finally {
      setRedactor(originalRedactor);
    }
  });
  console.log('PASS: redacted results report persisted byte length');

  await withTempDir(async (dir) => {
    const store = new JobStore({ stateRoot: dir });
    const output = await executeRun({
      store, adapter: adapterFor(''), repoKey: 'empty-result', prompt: 'test prompt', hardTimeoutSec: 60,
    });
    const status = store.readStatus({ repoKey: 'empty-result', jobId: output.jobId });
    assert.strictEqual(status.state, 'done');
    assert.strictEqual(status.result_bytes, 0);
  });
  console.log('PASS: empty results remain classifiable');

  await withTempDir(async (dir) => {
    const store = new JobStore({ stateRoot: dir });
    let attemptDir;
    const createAttemptDir = store.createAttemptDir.bind(store);
    store.createAttemptDir = (args) => {
      createAttemptDir(args);
      attemptDir = path.join(store.getJobDir(args.repoKey, args.jobId), 'attempts', String(args.attemptNum));
    };
    const adapter = adapterFor('must not disappear');
    const collectResult = adapter.CollectResult.bind(adapter);
    adapter.CollectResult = (attempt) => {
      const result = collectResult(attempt);
      fs.rmSync(attemptDir, { recursive: true, force: true });
      return result;
    };
    const output = await executeRun({
      store, adapter, repoKey: 'persistence-failure', prompt: 'test prompt', hardTimeoutSec: 60,
    });
    const status = store.readStatus({ repoKey: 'persistence-failure', jobId: output.jobId });
    assert.strictEqual(output.exitCode, 11);
    assert.strictEqual(status.state, 'failed');
    assert.strictEqual(status.failure_reason, 'result_persistence_failed');
    assert.strictEqual(status.result_bytes, 0);
  });
  console.log('PASS: persistence failures are terminally visible');
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack || err.message}`);
  process.exitCode = 1;
});
