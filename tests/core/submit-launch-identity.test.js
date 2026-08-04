// @suite full
// @serial  owns a detached worker
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { JobStore } = require('../../core/job-store');
const { executeSubmit } = require('../../core/commands/submit');
const { executeCancel } = require('../../core/commands/cancel');
const { isProcessAlive, parseWorkerIdentity } = require('../../core/process-identity');
const { FakeAdapter } = require('../../adapters/fake/adapter');

function waitForDeath(pid) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      if (!isProcessAlive(pid)) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`worker ${pid} survived teardown`));
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function main() {
  const fixtureRoot = path.resolve(__dirname, '../../.tmp-test');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const stateRoot = fs.mkdtempSync(path.join(fixtureRoot, 'dcli-submit-identity-'));
  const preload = path.join(stateRoot, 'delay-worker-start.js');
  const previousNodeOptions = process.env.NODE_OPTIONS;
  let workerPid = null;
  try {
    fs.writeFileSync(preload,
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);\n',
      'utf8');
    process.env.NODE_OPTIONS = `${previousNodeOptions ? previousNodeOptions + ' ' : ''}--require=${preload}`;

    const store = new JobStore({ stateRoot });
    const result = await executeSubmit({
      store,
      adapter: new FakeAdapter({
        facts: [{ type: 'started', backend_pid: 4242, delayMs: 50 }],
        behaviors: { hangAfter: 'started' },
        capabilities: { schema_version: 1, backend: 'fake', core: { submit: true }, extensions: {} },
      }),
      repoKey: 'test-repo',
      repoRoot: process.cwd(),
      prompt: 'background task',
      hardTimeoutSec: 60,
    });

    const status = store.readStatus({ repoKey: 'test-repo', jobId: result.jobId });
    workerPid = status.worker_pid;
    assert.ok(Number.isInteger(workerPid) && workerPid > 0,
      'submit must persist the real worker pid before the worker reaches its own startup code');
    assert.ok(status.worker_identity, 'submit must persist worker identity before returning');
    assert.strictEqual(parseWorkerIdentity(status.worker_identity).pid, workerPid,
      'worker identity must name the persisted worker pid');
    assert.ok(isProcessAlive(workerPid), 'the persisted worker must actually be alive');
    assert.ok(status.execution_token, 'launch ownership must have a durable execution token');

    const backendDeadline = Date.now() + 10000;
    let backendStatus = status;
    while (Date.now() < backendDeadline && backendStatus.backend_pid !== 4242) {
      await new Promise(resolve => setTimeout(resolve, 50));
      backendStatus = store.readStatus({ repoKey: 'test-repo', jobId: result.jobId });
    }
    assert.strictEqual(backendStatus.backend_pid, 4242,
      'a started fact must persist the backend pid while the job is still running');

    const cancelled = await executeCancel({
      store,
      adapter: new FakeAdapter({ declaredRungs: ['hard_kill'] }),
      repoKey: 'test-repo',
      jobId: result.jobId,
    });
    assert.strictEqual(cancelled.exitCode, 0, 'cancel must confirm termination of a submitted worker');
    assert.strictEqual(store.readStatus({ repoKey: 'test-repo', jobId: result.jobId }).state, 'cancelled');
    await waitForDeath(workerPid);
    workerPid = null;

    console.log('PASS: submit persists launch identity, backend pid, and cancellation proof');
  } finally {
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
    if (workerPid && isProcessAlive(workerPid)) {
      try { process.kill(workerPid, 'SIGKILL'); } catch {}
      await waitForDeath(workerPid);
    }
    try { fs.rmSync(stateRoot, { recursive: true, force: true }); } catch {}
  }
}

main().catch(err => {
  console.error('FATAL:', err.stack || err.message);
  process.exit(1);
});
