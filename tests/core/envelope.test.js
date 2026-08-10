// @suite quick
const assert = require('node:assert');

const { buildEnvelope } = require('../../core/envelope');

async function main() {

// ===========================================================================
// 1. --json envelope has schema_version, all fields present, null when unset
// ===========================================================================
{
  const envelope = buildEnvelope({
    job_id: 'test-job',
    backend: 'fake',
    state: 'done',
    phase: 'terminal',
    attempt: 1,
    command_exit_code: 0,
    backend_exit_code: null,
    failure_reason: null,
    failure: null,
    findings_status: null,
  });

  assert.strictEqual(envelope.schema_version, 1, 'envelope must have schema_version');
  assert.strictEqual(envelope.job_id, 'test-job');
  assert.strictEqual(envelope.state, 'done');
  assert.strictEqual(envelope.command_exit_code, 0);
  assert.strictEqual(envelope.backend_exit_code, null);
  assert.strictEqual(envelope.findings, null);
  assert.strictEqual(envelope.findings_status, null);
  // All fields present
  const required = ['schema_version', 'job_id', 'backend', 'state', 'phase', 'attempt',
    'command_exit_code', 'backend_exit_code', 'failure_reason', 'failure', 'findings', 'findings_status'];
  for (const f of required) {
    assert.ok(f in envelope, `envelope must have field "${f}"`);
  }
}
console.log('PASS: --json envelope test');

// ===========================================================================
// 2. status --json emits envelope
// ===========================================================================
{
  const envelope = buildEnvelope({
    job_id: 'json-test',
    backend: 'fake',
    state: 'running',
    phase: 'agent_running',
    attempt: 2,
    command_exit_code: null,
    backend_exit_code: null,
    failure_reason: null,
    failure: null,
    findings_status: null,
  });

  assert.strictEqual(envelope.schema_version, 1);
  assert.strictEqual(envelope.state, 'running');
  assert.strictEqual(envelope.attempt, 2);
  assert.strictEqual(envelope.command_exit_code, null);
  assert.strictEqual(envelope.backend_exit_code, null);
}
console.log('PASS: status --json envelope');

}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
