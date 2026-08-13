// @suite full
// Ticket 81: an unresolvable /session/status must not read as "still working".
// Driven through the ticket-100 transport seam: a scripted transport supplies
// the raw HTTP responses and the production turn module (SSE reconnect, status
// polling, the unknown-status bound) runs for real. No _testMode, no private
// methods — this is the production reconciliation logic.
const assert = require('node:assert');
const { OpencodeTurn } = require('../../../adapters/opencode/turn');
const { FakeTransport } = require('../../fixtures/fake-transport');
const { validateFact } = require('../../../core/fact-types');
const { reduce } = require('../../../core/reducer');

const FAST_TIMINGS = {
  pollIntervalMs: 0,
  interactionPollMs: 1000000,
  idleConfirmMs: 1,
  unresolvedStatusLimitMs: 0,
};

function makeTurn(statusResponder, limitMs) {
  const transport = new FakeTransport({
    script: {
      '/session/status': () => statusResponder(),
      '/session/ses_81/message': {
        parts: [
          { id: 'p1', messageID: 'msg_1', type: 'text', text: 'partial answer' },
          { id: 'p2', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 10, input: 8, output: 2 }, cost: 0.0001 },
        ],
      },
    },
  });
  return {
    transport,
    turn: new OpencodeTurn({
      transport,
      buildPath: (ep) => ep,
      timings: { ...FAST_TIMINGS, unresolvedStatusLimitMs: limitMs },
    }),
  };
}

async function collect(turn) {
  const facts = [];
  for await (const fact of turn.run({
    session: { id: 'ses_81', promptSentAt: Date.now(), backendPid: 4242 },
    deadline: null,
  })) {
    facts.push(fact);
    validateFact(fact);
    if (fact.type === 'process_exited') break;
    assert.ok(facts.length < 500, 'Observe must terminate, not poll forever');
  }
  return facts;
}

async function main() {
  const results = [];

  async function run(name, fn) {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`PASS: ${name}`);
    } catch (e) {
      results.push({ name, ok: false, error: e.message });
      console.error(`FAIL: ${name} — ${e.message}`);
    }
  }

  // 1. A status response the parse cannot resolve is bounded, and the job fails
  //    with a reason that names the ambiguity — never done, never silent.
  await run('unresolvable status is bounded and reported honestly', async () => {
    let polls = 0;
    const { turn } = makeTurn(() => { polls++; return { status: 200, body: 'not-an-object' }; }, 0);
    const facts = await collect(turn);

    assert.ok(polls >= 2, `status must actually be polled (got ${polls})`);
    assert.ok(!facts.some(f => f.type === 'backend_status'),
      'an unresolvable status is not published as progress');

    const err = facts.find(f => f.type === 'backend_error');
    assert.ok(err, 'backend_error emitted on exhaustion');
    assert.strictEqual(err.class_hint, 'backend_status_unresolved');
    assert.match(err.structured_payload.message, /unresolvable/);
    assert.ok(facts.some(f => f.type === 'process_exited'), 'stream terminates');

    const decided = reduce({ state: 'running' }, facts, {});
    assert.strictEqual(decided.state, 'failed', 'must not reduce to done');
    assert.strictEqual(decided.failure_reason, 'backend_status_unresolved');
  });

  // 2. A poll that keeps throwing is the same ambiguity, not an implicit wait.
  await run('repeatedly failing status poll is bounded too', async () => {
    const { turn } = makeTurn(() => { throw new Error('ECONNRESET'); }, 0);
    const facts = await collect(turn);
    const err = facts.find(f => f.type === 'backend_error');
    assert.ok(err, 'backend_error emitted');
    assert.strictEqual(err.class_hint, 'backend_status_unresolved');
    assert.match(err.structured_payload.message, /poll_failed/);
  });

  // 3. The bound resets on a resolved status: a healthy turn must not be
  //    failed just because one poll was unresolvable.
  await run('a resolved status clears the unresolved bound', async () => {
    const seq = [
      { status: 200, body: 'not-an-object' },
      { ses_81: { type: 'busy' } },
      { ses_81: { type: 'idle' } },
    ];
    let i = 0;
    const { turn } = makeTurn(() => seq[Math.min(i++, seq.length - 1)], 0);
    const facts = await collect(turn);

    assert.ok(!facts.some(f => f.type === 'backend_error' && f.class_hint === 'backend_status_unresolved'),
      'no unresolved failure once status resolves');
    const decided = reduce({ state: 'running' }, facts, {});
    assert.strictEqual(decided.state, 'done', 'healthy turn still completes');
  });

  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log(`\nunresolved-status-bound: ${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
