// @suite full
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { JobStore } = require('../../core/job-store');
const { computeRepoKeyWithPath } = require('../../core/repo-key');
const { DEFAULT_TIMEOUT } = require('../run-tests');
const { assertSpawnStatus } = require('../helpers/spawn-assert');

const CLI = path.resolve(__dirname, '../../cli/dcli.js');
const TERMINAL = ['done', 'failed', 'timed_out', 'cancelled', 'interrupted'];

async function main() {
  const { repoKey } = computeRepoKeyWithPath(process.cwd());

  // =========================================================================
  // 1. Submit with fake adapter reaches terminal state without any other CLI
  //    invocation staying alive
  // =========================================================================
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-submit-e2e-'));
    try {
      const env = { ...process.env, DCLI_STATE_ROOT: dir };
      const result = spawnSync(process.execPath, [CLI, '--backend', 'fake', 'submit', '--hard-timeout-sec', '60', '--group', 't29', 'background task from test'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: DEFAULT_TIMEOUT,
        env,
      });
      assertSpawnStatus(result, 0, 'submit must exit 0', DEFAULT_TIMEOUT);

      const jobId = result.stdout.trim();
      assert.ok(jobId.length >= 16, `Expected jobId, got: "${jobId}"`);

      // Poll store until terminal (worker runs as detached background process)
      const store = new JobStore({ stateRoot: dir });
      const deadline = Date.now() + 60000;
      let status;
      let lastState = 'created';
      do {
        await new Promise(r => setTimeout(r, 200));
        try {
          status = store.readStatus({ repoKey, jobId });
          lastState = status.state;
        } catch {
          // Journal may be in flight
        }
      } while (!TERMINAL.includes(lastState) && Date.now() < deadline);

      assert.ok(TERMINAL.includes(lastState), `Worker did not reach terminal state within timeout. Last state: ${lastState}`);
      assert.strictEqual(lastState, 'done', `Expected 'done', got '${lastState}'`);
      console.log(`PASS: Submit e2e reached ${lastState} (job ${jobId})`);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  // =========================================================================
  // 2. wait --all --group actually waits for terminal state
  // =========================================================================
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-submit-e2e-wait-'));
    try {
      const env = { ...process.env, DCLI_STATE_ROOT: dir };
      const submitResult = spawnSync(process.execPath, [CLI, '--backend', 'fake', 'submit', '--hard-timeout-sec', '60', '--group', 't29-wait', 'background task'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: DEFAULT_TIMEOUT,
        env,
      });
      assertSpawnStatus(submitResult, 0, 'submit must exit 0', DEFAULT_TIMEOUT);

      // Now wait --all --group should complete (not time out)
      const waitResult = spawnSync(process.execPath, [CLI, '--backend', 'fake', 'wait', '--group', 't29-wait', '--all', '--timeout-sec', '90'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: DEFAULT_TIMEOUT,
        env,
      });
      assertSpawnStatus(waitResult, 0, 'wait --all must exit 0', DEFAULT_TIMEOUT);
      assert.ok(waitResult.stdout.includes('done'), `Expected 'done' in wait output: ${waitResult.stdout}`);
      console.log('PASS: wait --all --group completes for submit-created jobs');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  // =========================================================================
  // 3. Submit with admission controller works (slot acquired by worker)
  // =========================================================================
  {
    const { AdmissionController } = require('../../core/admission');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-submit-e2e-adm-'));
    try {
      const env = { ...process.env, DCLI_STATE_ROOT: dir };
      const result = spawnSync(process.execPath, [CLI, '--backend', 'fake', 'submit', '--hard-timeout-sec', '60', '--group', 't29-adm', 'another background task'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: DEFAULT_TIMEOUT,
        env,
      });
      assertSpawnStatus(result, 0, 'submit must exit 0', DEFAULT_TIMEOUT);
      const jobId = result.stdout.trim();
      assert.ok(jobId.length >= 16);

      // Poll store until terminal
      const store = new JobStore({ stateRoot: dir });
      const deadline = Date.now() + 60000;
      let status;
      let lastState = 'created';
      do {
        await new Promise(r => setTimeout(r, 200));
        try {
          status = store.readStatus({ repoKey, jobId });
          lastState = status.state;
        } catch {}
      } while (!TERMINAL.includes(lastState) && Date.now() < deadline);

      assert.ok(TERMINAL.includes(lastState), `Expected terminal, got ${lastState}`);

      // Verify admission slot was properly managed
      const admission = new AdmissionController({ stateRoot: dir });
      const util = admission.getUtilization();
      assert.strictEqual(util.global.active, 0, 'Admission slot should be released after worker exits');
      console.log('PASS: Admission slot released after worker completion');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  console.log('All submit e2e tests passed.');
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
