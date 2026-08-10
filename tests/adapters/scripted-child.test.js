// @suite quick
// Ticket 99. The codex and claude adapters used to open every meaningful
// method with `if (this._testMode) { ...; return }`, so a test that set it
// exercised none of the framing, drain, exit-ordering or classification code —
// exactly the code that needed four separate fixes (docs/engineering/lessons.md
// §3). The `_spawn` seam replaces that: a test injects a scripted fake child
// and everything downstream runs for real.
//
// These are the three orderings a real child produces that the old double
// could not represent, each of which the `_testMode` branch skipped:
//
//   1. a partial line split across two stdout chunks — framing is real,
//      not a pre-split mock facts array;
//   2. stdout data arriving AFTER the exit event — the bounded drain and the
//      final line-buffer flush are what deliver it, and only a child that can
//      reproduce the exit-then-data order tests that;
//   3. a dropped wake-up — lessons §3: a parked drain must re-check its own
//      terminal condition on a refed interval, so a wake nobody sends must
//      degrade to a short delay, never a hang.
//
// Every wait in this file is bounded by the test itself, so a regression fails
// loudly instead of hanging the suite.
const assert = require('node:assert');
const { ScriptedChild } = require('../fixtures/scripted-child');

const OBSERVE_BUDGET_MS = 10000;
const PARK_WAIT_MS = 1000;

function scriptedAdapter(AdapterClass) {
  const adapter = new AdapterClass();
  const fake = new ScriptedChild();
  let invocation = null;
  adapter._spawn = (inv) => {
    invocation = inv;
    return fake;
  };
  return { adapter, fake, invocation: () => invocation };
}

function teardown(adapter) {
  try { adapter.Dispose({}); } catch {}
}

async function raceWithBudget(drainPromise, budgetMs) {
  let timedOut = false;
  // A REFED timer: it is also what guarantees this test process cannot itself
  // evaporate the way the lesson §3 bug made `dcli-codex run` evaporate.
  const budget = new Promise((resolve) => {
    setTimeout(() => { timedOut = true; resolve(); }, budgetMs);
  });
  await Promise.race([drainPromise, budget]);
  return timedOut;
}

async function waitUntil(fn, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return fn();
}

async function tick() {
  await new Promise(r => setTimeout(r, 10));
}

async function runScripted(AdapterClass, script) {
  const { adapter, fake, invocation } = scriptedAdapter(AdapterClass);
  try {
    await adapter.Start({});
    assert.ok(invocation(), 'Start must route the spawn through _spawn');
    assert.ok(Array.isArray(invocation().args) && invocation().args.length > 0,
      'the seam must receive the argument array, never a shell string');
    assert.ok(invocation().options && invocation().options.stdio,
      'the seam must receive the spawn options the adapter built');
    await adapter.SendPrompt({}, 'Reply with exactly PONG.');
    await script(adapter, fake);
  } finally {
    teardown(adapter);
  }
}

const CODEX_EVENTS = {
  // Split so the JSON value is torn across the two chunks.
  split: () => ['{"type":"assistant_text","content":"hel', 'lo"}\n'],
  afterExit: () => '{"type":"assistant_text","content":"survives-drain"}',
};

const CLAUDE_EVENTS = {
  split: () => [
    '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"hel',
    'lo"}]}}\n',
  ],
  afterExit: () => '{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"survives-drain"}]}}',
};

async function main() {

// ===========================================================================
// 1. Split partial line: two stdout chunks carrying one torn JSON line must
//    frame into exactly one fact. The old test-mode branch returned the mock
//    facts pre-split, so a framing bug could never fail a test.
// ===========================================================================
for (const spec of [
  { name: 'codex', mod: '../../adapters/codex/adapter', cls: 'CodexAdapter', events: CODEX_EVENTS },
  { name: 'claude', mod: '../../adapters/claude/adapter', cls: 'ClaudeAdapter', events: CLAUDE_EVENTS },
]) {
  const AdapterClass = require(spec.mod)[spec.cls];
  await runScripted(AdapterClass, async (adapter, fake) => {
    const [chunk1, chunk2] = spec.events.split();

    const facts = [];
    const drainDone = raceWithBudget((async () => {
      for await (const f of adapter.Observe({})) facts.push(f);
    })(), OBSERVE_BUDGET_MS);
    await tick();

    fake.pushStdout(chunk1);
    await tick();
    assert.strictEqual(adapter._lineBuffer, chunk1,
      `${spec.name}: the first chunk must sit unbuffered in _lineBuffer, unparsed`);
    assert.strictEqual(adapter._liveFacts.length, 0,
      `${spec.name}: a torn line must not be parsed before the newline arrives`);

    fake.pushStdout(chunk2);
    await tick();
    fake.emitExit(0);
    fake.closeStreams();

    const timedOut = await drainDone;
    assert.ok(!timedOut, `${spec.name}: Observe must complete after exit + close`);

    const text = facts.filter(f => f.type === 'assistant_text');
    assert.strictEqual(text.length, 1,
      `${spec.name}: two chunks must frame into exactly one assistant_text fact, ` +
      `got ${text.length}: ${JSON.stringify(facts.map(f => f.type))}`);
    assert.strictEqual(text[0].text, 'hello',
      `${spec.name}: the torn value must be re-joined, got ${JSON.stringify(text[0].text)}`);
    assert.strictEqual(facts[facts.length - 1].type, 'process_exited',
      `${spec.name}: process_exited must be the terminal fact`);
    assert.strictEqual(facts[facts.length - 1].code, 0);
  });
}

// ===========================================================================
// 2. Output after exit: a child can emit stdout data after its exit event.
//    The bounded drain plus the final line-buffer flush must deliver it, and
//    Observe must terminate (the lesson §3 drain is a hard point, not a
//    convenience). Under _testMode, Observe returned before this code existed.
// ===========================================================================
for (const spec of [
  { name: 'codex', mod: '../../adapters/codex/adapter', cls: 'CodexAdapter', events: CODEX_EVENTS },
  { name: 'claude', mod: '../../adapters/claude/adapter', cls: 'ClaudeAdapter', events: CLAUDE_EVENTS },
]) {
  const AdapterClass = require(spec.mod)[spec.cls];
  await runScripted(AdapterClass, async (adapter, fake) => {
    const facts = [];
    // Observe starts BEFORE the child terminates, so the drain is genuinely
    // waiting on stream close when the exit event lands.
    const drainDone = raceWithBudget((async () => {
      for await (const f of adapter.Observe({})) facts.push(f);
    })(), OBSERVE_BUDGET_MS);
    await tick();

    fake.emitExit(0);
    fake.pushStdout(spec.events.afterExit());
    await tick();
    fake.closeStreams();

    const timedOut = await drainDone;
    assert.ok(!timedOut,
      `${spec.name}: Observe must finish when output arrives after exit — a drain ` +
      `that waited on something other than stream close would hang here`);

    const text = facts.filter(f => f.type === 'assistant_text');
    assert.strictEqual(text.length, 1,
      `${spec.name}: post-exit output must be drained and delivered, got ` +
      `${text.length} assistant_text facts: ${JSON.stringify(facts.map(f => f.type))}`);
    assert.strictEqual(text[0].text, 'survives-drain',
      `${spec.name}: the drained fragment must reach the observer verbatim`);

    if (spec.name === 'claude') {
      const result = adapter.CollectResult({});
      assert.strictEqual(result.text, 'survives-drain',
        `${spec.name}: the drained output must also survive into CollectResult`);
      assert.strictEqual(result.result_status, 'missing',
        `${spec.name}: no result event was seen, so status must stay 'missing'`);
    }
  });
}

// ===========================================================================
// 3. Missed wake-up (lessons §3): the exit handler wakes the live drain, but
//    the design must not DEPEND on being woken — a dropped wake-up must cost
//    one re-check interval, never a hang. Script the drop through the real
//    path: park the drain, discard its stored resolver, then exit the child.
// ===========================================================================
for (const spec of [
  { name: 'codex', mod: '../../adapters/codex/adapter', cls: 'CodexAdapter' },
  { name: 'claude', mod: '../../adapters/claude/adapter', cls: 'ClaudeAdapter' },
]) {
  const AdapterClass = require(spec.mod)[spec.cls];
  const { adapter, fake } = scriptedAdapter(AdapterClass);
  try {
    await adapter.Start({});
    await adapter.SendPrompt({}, 'Reply with exactly PONG.');

    const facts = [];
    let ended = false;
    const drain = (async () => {
      for await (const f of adapter.Observe({})) facts.push(f);
      ended = true;
    })();

    const parked = await waitUntil(() => typeof adapter._liveFactsResolve === 'function', PARK_WAIT_MS);
    assert.ok(parked,
      `${spec.name}: the live drain must park on a stored resolver for this test to be meaningful`);

    // Drop the wake-up, exactly as the original bug did: the exit handler's
    // wake call then finds no resolver to call.
    adapter._liveFactsResolve = null;
    fake.emitExit(0);
    fake.closeStreams();

    const timedOut = await raceWithBudget(drain, OBSERVE_BUDGET_MS);
    assert.ok(!timedOut && ended,
      `${spec.name}: a dropped wake-up must degrade to a bounded delay, not a permanent park`);
    const exited = facts.filter(f => f.type === 'process_exited');
    assert.strictEqual(exited.length, 1,
      `${spec.name}: the child's exit must still be observed: ${JSON.stringify(facts.map(f => f.type))}`);
    assert.strictEqual(exited[0].code, 0);
  } finally {
    teardown(adapter);
  }
}

console.log('scripted-child: all assertions passed');
}

main().catch(err => { console.error(err.stack || String(err)); process.exit(1); });
