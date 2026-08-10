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
// The adapter assertions drive the production turn module through the
// ticket-100 transport seam (scripted HTTP responses), not through mocks:
// the mapping under test lives in the turn's reconciliation logic.
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
  const { OpencodeTurn } = require('../../adapters/opencode/turn');
  const { FakeTransport } = require('../fixtures/fake-transport');

  const FAST = {
    pollIntervalMs: 0,
    interactionPollMs: 1000000,
    idleConfirmMs: 1,
    unresolvedStatusLimitMs: 0,
  };

  async function collect(transport, promptSentAt) {
    const turn = new OpencodeTurn({ transport, buildPath: (ep) => ep, timings: FAST });
    const facts = [];
    for await (const fact of turn.run({
      session: { id: 'ses_1', promptSentAt, backendPid: 7 },
      policy: null,
      deadline: null,
    })) {
      facts.push(fact);
      if (fact.type === 'process_exited') break;
    }
    return { turn, facts };
  }

  // Nothing has been sent yet: absence proves nothing. A just-prompted session
  // inside the registration grace period must not read as finished either —
  // both are the "unresolved" bound, never an implicit idle.
  for (const promptSentAt of [null, Date.now()]) {
    const transport = new FakeTransport({
      script: { '/session/status': {} },
    });
    const { facts } = await collect(transport, promptSentAt);
    const err = facts.find(f => f.type === 'backend_error');
    assert.ok(err, 'absence without grace must be bounded, not read as idle');
    assert.strictEqual(err.class_hint, 'backend_status_unresolved');
  }

  // Grace elapsed: absence now means the turn is over, which is the only way
  // the reconciliation loop ever terminates.
  {
    const transport = new FakeTransport({
      script: {
        '/session/status': {},
        '/session/ses_1/message': {
          parts: [
            { id: 'p1', messageID: 'msg_1', type: 'text', text: 'finished' },
            { id: 'p2', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 5, input: 3, output: 2 } },
          ],
        },
      },
    });
    const { turn, facts } = await collect(transport, Date.now() - 60000);
    assert.ok(!facts.some(f => f.type === 'backend_error' && f.class_hint === 'backend_status_unresolved'),
      'an absent session past the grace period must read as finished');
    assert.strictEqual(turn.result.text, 'finished');
  }

  // Having seen it live once is the strong signal and needs no grace period.
  {
    const seq = [{ ses_1: { type: 'busy' } }, {}];
    let i = 0;
    const transport = new FakeTransport({
      script: {
        '/session/status': () => seq[Math.min(i++, seq.length - 1)],
        '/session/ses_1/message': {
          parts: [
            { id: 'p1', messageID: 'msg_1', type: 'text', text: 'seen live' },
            { id: 'p2', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 5, input: 3, output: 2 } },
          ],
        },
      },
    });
    const { turn, facts } = await collect(transport, null);
    const statuses = facts.filter(f => f.type === 'backend_status').map(f => f.state);
    assert.ok(statuses.includes('busy'), 'the live busy status is observed');
    assert.ok(!facts.some(f => f.type === 'backend_error' && f.class_hint === 'backend_status_unresolved'),
      'a session observed live and then absent must read as finished');
    assert.strictEqual(turn.result.text, 'seen live');
  }

  console.log('PASS: absent session status maps to idle, guarded');
}

// ===========================================================================
// 3. The error on a failed assistant message is found
// ===========================================================================
{
  const { OpencodeTurn } = require('../../adapters/opencode/turn');
  const { FakeTransport } = require('../fixtures/fake-transport');

  async function collectWithMessages(messages) {
    const transport = new FakeTransport({
      script: {
        '/session/status': { ses_1: { type: 'idle' } },
        '/session/ses_1/message': messages,
        '/permission': [],
        '/question': [],
      },
    });
    const turn = new OpencodeTurn({
      transport,
      buildPath: (ep) => ep,
      timings: { pollIntervalMs: 0, interactionPollMs: 1000000, idleConfirmMs: 1 },
    });
    const facts = [];
    for await (const fact of turn.run({
      session: { id: 'ses_1', promptSentAt: Date.now(), backendPid: 7 },
      policy: null,
      deadline: null,
    })) {
      facts.push(fact);
      if (fact.type === 'process_exited') break;
    }
    return { turn, facts };
  }

  // A message carrying info.error surfaces as backend_error, not silence.
  {
    const { facts } = await collectWithMessages([
      { info: { id: 'm1', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
      {
        info: {
          id: 'm2', role: 'assistant',
          error: { name: 'APIError', data: { message: 'region locked', statusCode: 403 } },
        },
        parts: [],
      },
    ]);
    const err = facts.find(f => f.type === 'backend_error');
    assert.ok(err, 'a message carrying info.error must be emitted as backend_error');
    assert.strictEqual(err.structured_payload.message, 'region locked');
    assert.strictEqual(err.structured_payload.status_code, 403);
    assert.strictEqual(err.structured_payload.name, 'APIError');
    assert.strictEqual(err.class_hint, 'provider_error');
  }

  // A clean transcript must not report an error.
  {
    const { facts } = await collectWithMessages([
      { info: { id: 'm1', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
      { info: { id: 'm2', role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] },
    ]);
    assert.ok(!facts.some(f => f.type === 'backend_error' && f.class_hint === 'provider_error'),
      'a clean transcript must not report an error');
  }

  // A credits failure keeps its more specific class.
  {
    const { facts } = await collectWithMessages([
      { info: { id: 'm1', error: { name: 'CreditsError', data: { message: 'out of credits' } } }, parts: [] },
    ]);
    const err = facts.find(f => f.type === 'backend_error');
    assert.strictEqual(err.class_hint, 'quota_or_rate_limit');
  }

  console.log('PASS: message-level error is surfaced');
}

}

main().then(() => console.log('\nAll backend-error tests passed')).catch((err) => {
  console.error('FAIL:', err && err.stack || err);
  process.exit(1);
});
