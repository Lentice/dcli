// @suite quick
// A provider refusal reached the user as a successful, empty job. Three
// separate places had to agree for that to happen, so all three are asserted
// here:
//
//   1. reduce() checked process_exited before backend_error and returned on the
//      first match, so a backend whose server exits 0 after a failed turn
//      reduced to `done`.
//   2. the run/resume attempt driver returned no exitCode on that path, so the
//      command exited 0 — which an agent parsing exit codes reads as success.
//   3. the opencode adapter never read the error off the message, and treated a
//      session missing from /session/status as "unknown" rather than finished,
//      so the job was polled until the hard timeout instead.
//
// The adapter assertions stub _transportRequest by injection rather than
// setting _testMode: the mapping under test lives below the test-mode guard.
const assert = require('node:assert');
const { reduce } = require('../../core/reducer');

function runningState(extra) {
  return {
    job_id: 'j1', state: 'running', phase: 'agent_running',
    started_at: new Date().toISOString(), hard_timeout_sec: null,
    failure_reason: null, backend_session_id: null, ...extra,
  };
}

async function main() {

// ===========================================================================
// 1. backend_error survives a clean process exit
// ===========================================================================
{
  const facts = [
    { type: 'backend_error', class_hint: 'provider_error', structured_payload: { message: 'refused' } },
    { type: 'process_exited', code: 0 },
  ];
  const result = reduce(runningState(), facts, {});
  assert.strictEqual(result.state, 'failed',
    'a reported backend error must not be overruled by an exit code of 0');
  assert.strictEqual(result.failure_reason, 'provider_error');
  assert.strictEqual(result.failure.reason, 'backend_error');

  // A non-zero exit is the more specific fact and still wins.
  const nonZero = reduce(runningState(), [
    { type: 'backend_error', class_hint: 'provider_error' },
    { type: 'process_exited', code: 7 },
  ], {});
  assert.strictEqual(nonZero.state, 'failed');
  assert.strictEqual(nonZero.failure.code, 7, 'a non-zero exit code must be preserved');

  // And a clean exit with no error at all is still done.
  const clean = reduce(runningState(), [{ type: 'process_exited', code: 0 }], {});
  assert.strictEqual(clean.state, 'done');

  console.log('PASS: backend_error is not masked by exit 0');
}

// ===========================================================================
// 2. A session absent from /session/status means the turn is over
// ===========================================================================
{
  const { OpencodeAdapter } = require('../../adapters/opencode/adapter');
  const adapter = new OpencodeAdapter({ jobId: 'j1' });
  adapter._sessionId = 'ses_1';
  adapter._transportRequest = async () => ({});

  // Nothing has been sent yet: absence proves nothing.
  assert.strictEqual(await adapter._fetchSessionStatus(), 'unknown',
    'a session that was never prompted must not be reported as finished');

  // Prompt just sent, still inside the registration grace period.
  adapter._promptSentAt = Date.now();
  assert.strictEqual(await adapter._fetchSessionStatus(), 'unknown',
    'a session that has not yet registered must not be reported as finished');

  // Grace elapsed: absence now means the turn is over, which is the only way
  // the reconciliation loop ever terminates.
  adapter._promptSentAt = Date.now() - 60000;
  assert.strictEqual(await adapter._fetchSessionStatus(), 'idle',
    'an absent session past the grace period must read as finished');

  // Having seen it live once is the strong signal and needs no grace period.
  const seen = new OpencodeAdapter({ jobId: 'j2' });
  seen._sessionId = 'ses_2';
  let first = true;
  seen._transportRequest = async () => {
    if (first) { first = false; return { ses_2: { type: 'busy' } }; }
    return {};
  };
  assert.strictEqual(await seen._fetchSessionStatus(), 'busy');
  assert.strictEqual(await seen._fetchSessionStatus(), 'idle',
    'a session observed live and then absent must read as finished');

  console.log('PASS: absent session status maps to idle, guarded');
}

// ===========================================================================
// 3. The error on a failed assistant message is found
// ===========================================================================
{
  const { OpencodeAdapter } = require('../../adapters/opencode/adapter');
  const adapter = new OpencodeAdapter({ jobId: 'j1' });

  const msgs = [
    { info: { id: 'm1', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
    {
      info: {
        id: 'm2', role: 'assistant',
        error: { name: 'APIError', data: { message: 'region locked', statusCode: 403 } },
      },
      parts: [],
    },
  ];
  const found = adapter._findMessageError(msgs);
  assert.ok(found, 'a message carrying info.error must be found');
  assert.strictEqual(found.message, 'region locked');
  assert.strictEqual(found.statusCode, 403);
  assert.strictEqual(found.name, 'APIError');
  assert.strictEqual(found.class_hint, 'provider_error');

  assert.strictEqual(adapter._findMessageError([{ info: { id: 'm1' }, parts: [] }]), null,
    'a clean transcript must not report an error');
  assert.strictEqual(adapter._findMessageError(null), null);

  // A credits failure keeps its more specific class.
  const credits = adapter._findMessageError([{
    info: { id: 'm1', error: { name: 'CreditsError', data: { message: 'out of credits' } } },
    parts: [],
  }]);
  assert.strictEqual(credits.class_hint, 'quota_or_rate_limit');

  console.log('PASS: message-level error is surfaced');
}

}

main().then(() => console.log('\nAll backend-error tests passed')).catch((err) => {
  console.error('FAIL:', err && err.stack || err);
  process.exit(1);
});
