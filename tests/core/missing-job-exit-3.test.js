// A job that does not exist must report exit 3, never a clean "created".
//
// regenerateStatus() rebuilds a projection from the journal, and an ABSENT
// journal is indistinguishable from an empty one: it returns the default
// status (job_id null, state 'created') rather than throwing. Every read-side
// command wrapped that call in try/catch and trusted the catch to mean "not
// found", so `status <typo'd-id>` printed state 'created' and exited 0. An
// agent polling that never stops — the job it is waiting for does not exist.
//
// Asserts the observable contract at the CLI boundary: exit code and stderr.

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', '..', 'cli', 'dcli.js');
const MISSING_ID = '20990101T000000Z-doesnotex';

function run(args, stateRoot) {
  return spawnSync(process.execPath, [CLI, '--backend', 'fake', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, DCLI_STATE_ROOT: stateRoot },
  });
}

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-missing-job-'));

try {
  for (const command of ['status', 'read', 'tail', 'debug', 'wait', 'cancel']) {
    const r = run([command, MISSING_ID, '--json'], stateRoot);
    const output = (r.stdout || '') + (r.stderr || '');

    assert.strictEqual(r.status, 3,
      `${command}: a missing job must exit 3, got ${r.status} with output: ${output}`);
    assert.ok(/Job not found/.test(output),
      `${command}: must say the job was not found, got: ${output}`);
    assert.ok(!/"state"\s*:\s*"created"/.test(output),
      `${command}: must not report a non-existent job as state "created", got: ${output}`);
    console.log(`PASS: ${command} reports a missing job as exit 3`);
  }

  // A real job still resolves — the existence check must not reject live jobs.
  const submitted = run(['submit', 'hello', '--json'], stateRoot);
  assert.strictEqual(submitted.status, 0, `submit must succeed: ${submitted.stdout}${submitted.stderr}`);
  const jobId = JSON.parse(submitted.stdout).job_id;
  assert.ok(jobId, 'submit must return a job id');

  const status = run(['status', jobId, '--json'], stateRoot);
  assert.strictEqual(status.status, 0, `status of a real job must exit 0: ${status.stderr}`);
  assert.strictEqual(JSON.parse(status.stdout).job_id, jobId, 'status must report the real job');
  console.log('PASS: an existing job is still found');

  console.log('\nAll missing-job tests passed.');
} finally {
  try { fs.rmSync(stateRoot, { recursive: true, force: true }); } catch {}
}
