const assert = require('node:assert');
const fs = require('fs');
const os = require('os');

const { buildWaitJson, executeWait } = require('../../core/commands/wait');

async function main() {
  const stateRoot = fs.mkdtempSync(`${os.tmpdir()}\\dcli-wait-contract-`);
  try {
    const status = {
      job_id: 'wait-contract',
      backend: 'fake',
      state: 'running',
      phase: 'agent_running',
      attempt: 1,
      command_exit_code: null,
      backend_exit_code: null,
      failure_reason: null,
      failure: null,
      findings_status: null,
    };
    const store = {
      getJobDir: () => stateRoot,
      reconcileStatus: () => status,
    };

    const result = await executeWait({
      store,
      repoKey: 'test',
      jobId: 'wait-contract',
      timeoutSec: 0,
    });

    assert.strictEqual(result.exitCode, 20);
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.waitTimeoutSec, 0);

    const singleJson = buildWaitJson(result);
    assert.strictEqual(singleJson.wait_timed_out, true);
    assert.strictEqual(singleJson.wait_timeout_sec, 0);
    assert.strictEqual(singleJson.state, 'running');

    const terminalResult = await executeWait({
      store: {
        getJobDir: () => stateRoot,
        reconcileStatus: () => ({ ...status, state: 'done', phase: 'terminal' }),
      },
      repoKey: 'test',
      jobId: 'wait-contract',
    });
    assert.strictEqual(terminalResult.timedOut, false);
    assert.strictEqual(terminalResult.waitTimeoutSec, 300);

    const allJson = buildWaitJson({
      timedOut: false,
      waitTimeoutSec: 300,
      jobs: [{ job_id: 'done', state: 'done', phase: 'terminal' }],
      errors: [],
    });
    assert.strictEqual(allJson.wait_timed_out, false);
    assert.strictEqual(allJson.wait_timeout_sec, 300);
    assert.deepStrictEqual(allJson.jobs[0], { job_id: 'done', state: 'done', phase: 'terminal' });

    console.log('PASS: wait contract reports caller timeout separately from job state');
  } finally {
    try { fs.rmSync(stateRoot, { recursive: true, force: true }); } catch {}
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
