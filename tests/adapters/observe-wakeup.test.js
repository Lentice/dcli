// @suite quick
// Ticket 79. The child `exit`/`error` handlers set `_observedExited = true` and
// called `_exitResolve()`, but never `_liveFactsResolve` — while
// `_drainLiveQueue()` was parked on exactly that resolver, re-checking
// `_observedExited` only *after* it settled. Nothing settled it.
//
// The second half of the failure is why it was invisible: once the child's
// pipes close and ProcessWrap is released, no refed libuv handle remains, so
// Node drains the loop and the whole process exits 0 in the middle of the
// `for await` — no result, no error. `dcli-codex run` returned exit 0 with zero
// bytes on both streams.
//
// These tests drive a real child (a silent .cmd fixture) so the missed-wake-up
// path runs for real: `Observe()` reaches `_drainLiveQueue` and the exit
// handlers, which is the code where this defect lived (AGENTS.md, "a mocked-out
// path is an uncovered path").
//
// Every wait below is bounded by the test itself, so a regression fails loudly
// with a named assertion instead of hanging the suite.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OBSERVE_BUDGET_MS = 15000;

// A fixture that stays alive briefly, writes NOTHING to stdout, then exits with
// a known code. Silence is the point: any stdout byte would wake the parked
// promise through the `data` handler and mask the defect. `ping` is the delay
// with no console of its own; `timeout` requires one.
//
// A .cmd fixture is safe here specifically because the adapters wrap every
// launch in `cmd.exe /d /s /c <pre-quoted>` (Node cannot spawn .cmd directly —
// EINVAL since 18.20/20.12).
function writeSilentFixture(dir, exitCode) {
  const p = path.join(dir, 'silent-then-exit.cmd');
  fs.writeFileSync(p, [
    '@echo off',
    'ping -n 2 127.0.0.1 >nul',
    `exit /b ${exitCode}`,
    '',
  ].join('\r\n'), 'utf8');
  return p;
}

// A leaked fixture tree poisons every later test on the machine.
function teardown(adapter) {
  if (adapter && adapter._childProcess) {
    try { adapter._childProcess.kill(); } catch {}
  }
  try { if (adapter) adapter.Dispose({}); } catch {}
}

async function collectFacts(adapter, budgetMs) {
  const facts = [];
  let timedOut = false;
  let timer;
  // A REFED timer: it is also what guarantees this test process cannot itself
  // evaporate the way the bug under test made `dcli-codex run` evaporate.
  const budget = new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; resolve('timeout'); }, budgetMs); });

  const drain = (async () => {
    for await (const f of adapter.Observe({})) facts.push(f);
    return 'ended';
  })();

  const outcome = await Promise.race([drain, budget]);
  clearTimeout(timer);
  return { facts, timedOut, outcome };
}

async function runRealObserve({ AdapterClass, pathEnvVar, exitCode }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-t79-'));
  const fixture = writeSilentFixture(tmp, exitCode);

  const adapter = new AdapterClass({});
  const saved = process.env[pathEnvVar];
  process.env[pathEnvVar] = fixture;

  try {
    await adapter.Start({});
    await adapter.SendPrompt({}, 'Reply with exactly PONG.');
    return await collectFacts(adapter, OBSERVE_BUDGET_MS);
  } finally {
    if (saved === undefined) delete process.env[pathEnvVar];
    else process.env[pathEnvVar] = saved;
    teardown(adapter);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function main() {

// ===========================================================================
// 1 & 2. A real child that exits without ever writing stdout must still be
//        observed exiting. This is the exact production shape that returned
//        exit 0 / 0 bytes.
// ===========================================================================
for (const spec of [
  { name: 'codex', mod: '../../adapters/codex/adapter', cls: 'CodexAdapter', env: 'CODEX_PATH', exitCode: 3 },
  { name: 'claude', mod: '../../adapters/claude/adapter', cls: 'ClaudeAdapter', env: 'CLAUDE_PATH', exitCode: 4 },
]) {
  const AdapterClass = require(spec.mod)[spec.cls];
  const { facts, timedOut } = await runRealObserve({
    AdapterClass, pathEnvVar: spec.env, exitCode: spec.exitCode,
  });

  assert.ok(!timedOut,
    `${spec.name}: Observe() must complete after the child exits. It did not within ` +
    `${OBSERVE_BUDGET_MS}ms, which is the missed wake-up: the exit handler set ` +
    `_observedExited but never resolved _liveFactsResolve, so _drainLiveQueue stayed parked.`);

  const exited = facts.filter(f => f.type === 'process_exited');
  assert.strictEqual(exited.length, 1,
    `${spec.name}: exactly one process_exited fact must be yielded, got ` +
    `${exited.length} of ${facts.length} facts: ${JSON.stringify(facts.map(f => f.type))}`);
  assert.strictEqual(exited[0].code, spec.exitCode,
    `${spec.name}: the child's real exit code must be carried on the fact`);
}

// ===========================================================================
// 3. Criterion B, pinned directly: even if a wake-up is DROPPED, the drain must
//    still finish. Without a bounded re-check this hangs forever, and in a
//    process with no other refed handle it exits 0 silently instead.
// ===========================================================================
for (const spec of [
  { name: 'codex', mod: '../../adapters/codex/adapter', cls: 'CodexAdapter' },
  { name: 'claude', mod: '../../adapters/claude/adapter', cls: 'ClaudeAdapter' },
]) {
  const AdapterClass = require(spec.mod)[spec.cls];
  const adapter = new AdapterClass({});

  // Drive _drainLiveQueue directly: no child, so nothing can wake it but the
  // bounded re-check the fix must introduce.
  const facts = [];
  let ended = false;
  const drain = (async () => {
    for await (const f of adapter._drainLiveQueue()) facts.push(f);
    ended = true;
  })();

  // Let it reach the parked await, then simulate the dropped wake-up: the
  // terminal condition becomes true while the stored resolver is discarded,
  // exactly as the exit handler did.
  await new Promise(r => setTimeout(r, 50));
  assert.ok(typeof adapter._liveFactsResolve === 'function',
    `${spec.name}: _drainLiveQueue must be parked on a stored resolver for this test to be meaningful`);
  adapter._liveFactsResolve = null;
  adapter._observedExited = true;

  let timer;
  const budget = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 5000); });
  const outcome = await Promise.race([drain.then(() => 'ended'), budget]);
  clearTimeout(timer);

  assert.strictEqual(outcome, 'ended',
    `${spec.name}: a dropped wake-up must degrade to a bounded delay, not a permanent park. ` +
    `_drainLiveQueue must re-check _observedExited on a refed interval.`);
  assert.ok(ended, `${spec.name}: the drain generator must complete`);
}

// ===========================================================================
// 4. The comment that hid the bug. `_waitForExit` returns a bare promise, which
//    never refs the libuv loop — the source claimed the opposite.
// ===========================================================================
for (const spec of [
  { name: 'codex', file: 'adapters/codex/adapter.js' },
  { name: 'claude', file: 'adapters/claude/adapter.js' },
]) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', spec.file), 'utf8');
  assert.ok(!/Deliberately a REFED \(not unref'd\) wait/.test(src),
    `${spec.name}: the claim that this wait is "REFED" is false — a bare promise refs nothing. ` +
    `Correct the comment (ticket 79 criterion C); leaving it re-creates the bug.`);
}

console.log('observe-wakeup: all assertions passed');
}

main().catch(err => { console.error(err.stack || String(err)); process.exit(1); });
