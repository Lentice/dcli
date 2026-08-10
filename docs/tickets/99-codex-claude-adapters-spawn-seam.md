# 99 — Codex and Claude adapters: an injected spawn seam replaces the inline `_testMode` double

**Status:** done
**Blocked by:** —
**Tier:** Test quality. The `_testMode` branch is the *first statement* of the methods that matter, so
an adapter test that sets it exercises approximately none of the adapter — and the code it skips is
exactly where the drain and wake-up bugs have historically lived.
**Filed from:** architecture review, 2026-08-10 (all three reviewers named this independently).

---

## Symptom / Goal

Counted at `adcbac1`: `_testMode` appears 9 times in `adapters/codex/adapter.js` and 8 times in
`adapters/claude/adapter.js`. The branches sit at the top of `DetectVersion`, `Start`, `Observe`,
`CollectResult` and `LiveSmoke`.

So a test that sets `_testMode` skips: process spawn, argv construction, stream framing, the drain, exit
ordering, and fact classification. Coverage of these adapters is nominal rather than real, in exactly
the code `docs/engineering/lessons.md` §3 says needed four separate fixes.

Meanwhile `adapters/fake/adapter.js` already exists as the honest test double. The `_testMode` branches
are a second, worse fake living inside the production code they are supposed to be testing.

Goal: one seam — the child process — injected by tests, so everything downstream of it runs for real.

## Root cause

There was no seam at the process boundary, so the only way to test without a real backend was to
short-circuit each method.

## Binding constraints — quoted, do not go looking for them

From `docs/design-spec.md` §9 (Adapter interface): adapters emit **normalized facts**; the engine's
reducer decides terminal state. This ticket must not change the fact vocabulary any method emits, and
must not let an adapter declare a job finished (invariant 2).

From `AGENTS.md`: "Argument arrays, never shell strings. No `cmd.exe /c`, no `/bin/sh -c` for ordinary
invocation, and never `shell: true`." The seam must not become a place where a command string is
assembled.

Read `docs/engineering/windows-spawning.md` before touching spawn, and
`docs/engineering/backend-pitfalls.md` for the drain and exit-ordering traps this code already handles —
those behaviours must survive intact, because after this change they will finally be under test.

ADR-009's discipline on `DCLI_TEST_*` knobs argues for this change: these are constructor options rather
than environment variables today, which is better, but they still ship in production code.

## Files to read and trace first

- `adapters/codex/adapter.js` — every `_testMode` branch and what each one bypasses.
- `adapters/claude/adapter.js` — the same.
- `adapters/shared/process-lifecycle.js` — `applyProcessLifecycle`, `_waitForFactsOrRecheck`,
  `_waitForStreamDrain`, `Recover`. This is the code the mocks currently skip; it is what the new tests
  will finally reach. Note the comment at the park-with-recheck bound explaining that the timer is the
  only refed handle keeping the process alive.
- `adapters/fake/adapter.js` — the existing honest double; anything that still needs a pure stub uses
  this instead of a `_testMode` branch.
- `tests/adapters/observe-wakeup.test.js` and the codex/claude adapter suites — every test that sets
  `_testMode` must be rewritten against the new seam or moved to the fake adapter.
- `tests/contract/suite.js` — the shared adapter contract tests; they must stay green unchanged.

## What to build

### 1. A `_spawn(invocation)` seam

Add one overridable method to each adapter (or, better, to `adapters/shared/process-lifecycle.js` so
both get it):

```js
_spawn(invocation) -> ChildProcess-like
```

Default implementation is today's `child_process.spawn` call, with today's options untouched. A test
supplies a scripted fake child — an object with `stdout`, `stderr`, `on`, `kill`, `pid` — and everything
downstream (framing, drain, classification, exit ordering) runs for real.

### 2. Delete every `_testMode` branch in these two adapters

Including the constructor options that feed them.

### 3. Rewrite the tests

Each test that set `_testMode` either drives a scripted fake child through `_spawn`, or uses
`adapters/fake/adapter.js` when it genuinely only needs a stub.

### 4. Add the tests the seam makes possible

At minimum, one each against the real downstream code: a partial line split across two `stdout` chunks;
output arriving after the `exit` event (the drain); and a missed-wake-up scenario from
`docs/engineering/lessons.md` §3.

## Non-goals

- **The opencode adapter.** Its 21 branches need a transport/SSE seam, not a spawn seam; that is
  ticket 100. Doing both here would double the size and mix two unrelated mechanics.
- **Replacing `applyProcessLifecycle`'s prototype mixin with composition.** A reviewer proposed it; it is
  a real design question but it is eight lines that work, and coupling it to this change would put a
  structural rewrite underneath a test-quality fix. File it separately if still wanted.
- **Changing any fact vocabulary, argv, or spawn option.** The point is that the existing behaviour
  becomes tested, not that it changes.

## Acceptance criteria

- [ ] **A.** `_testMode` and every `_mock*` constructor option are absent from
  `adapters/codex/adapter.js` and `adapters/claude/adapter.js`.
- [ ] **B.** Both adapters spawn through a single overridable `_spawn`, whose default is the current
  spawn call with the current options.
- [ ] **C.** Tests drive a scripted fake child; stream framing, drain and exit ordering execute for real
  in those tests.
- [ ] **D.** Three new tests exist: split partial line, output-after-exit drain, and a missed-wake-up
  case — each of which would have been skipped under `_testMode`.
- [ ] **E.** `tests/contract/suite.js` passes unchanged.
- [ ] **F.** No behaviour change: argv, spawn options, emitted facts and classification are identical.
- [ ] **Z.** `npm run check` green.

## Agent checks

```bash
# The inline double is gone from these two adapters.
grep -c "_testMode" adapters/codex/adapter.js adapters/claude/adapter.js
# expect: 0 and 0

# One spawn call per adapter, behind the seam.
grep -rn "spawn(" adapters/codex/adapter.js adapters/claude/adapter.js adapters/shared/process-lifecycle.js
# expect: exactly one real spawn, inside the default _spawn

# No shell invocation crept in.
grep -rn "shell: true\|cmd.exe /c\|/bin/sh -c" adapters/
# expect: nothing

npm run check
# expect: green
```

## Handoff

**Extra reading, beyond `AGENTS.md` and `00-onboarding.md`** — `docs/engineering/backend-pitfalls.md`
(the traps this code already handles), `docs/engineering/lessons.md` §3 (the four drain and wake-up
fixes), `docs/design-spec.md` §9 (adapter interface), and `docs/reference/cli-codex.md` +
`cli-claude.md` for how each backend is actually driven. Nothing else.

**Implementation order:**

1. Read every `_testMode` branch and write down, in Notes, **what each one bypasses**. That list is the
   coverage you are about to gain, and it tells you which tests will need real fixtures.
2. Add `_spawn(invocation)` to `adapters/shared/process-lifecycle.js` (both adapters use it), defaulting
   to today's spawn call with today's options **copied verbatim**. Run the suite — nothing changes yet.
3. Build a scripted fake child helper in `tests/fixtures/`: an `EventEmitter` with `stdout`/`stderr`
   streams, a `pid`, and a `kill()`, plus a way for a test to push chunks and then emit `exit`.
   `tests/fixtures/backpressure-child.js` and `tests/fixtures/grandchild-pipe.js` are the existing
   precedent for how a scripted child lives in this repository — follow their shape.
4. Convert one adapter's tests at a time, deleting each `_testMode` branch **only** once its test drives
   the fake child instead. Suite green after each conversion.
5. Add the three new tests (criterion D) — these are the payoff and cannot be skipped.

**Running tests while you work:**

```bash
node tests/adapters/observe-wakeup.test.js
node tests/contract/suite.js
npm run check
```

**Traps specific to this ticket:**

- **The drain is the hard part.** A child can emit stdout data *after* its `exit` event. Your fake child
  must be able to reproduce that ordering, or the test that matters most is not testing anything.
- Partial lines split across chunk boundaries are the other classic. Push `'{"typ'` and `'e":"x"}\n'` as
  two chunks and assert one fact.
- The park-with-recheck timer in `process-lifecycle.js` must stay **refed**. Its comment explains that it
  is the only handle keeping the process alive during a drain; an `unref()` there exits 0 mid-drain.
- Do not change argv construction, spawn options, or emitted facts. Criterion F is that behaviour is
  identical — the change is that it is finally observed.
- `adapters/fake/adapter.js` already exists. If a test only needs a stub, use it; do not build a second
  fake inside the scripted-child helper.

**Commit message:**

```
ticket 99: codex and claude adapters spawn through an injected seam
```

## Notes

### What each `_testMode` branch bypassed (the coverage gained)

Both adapters had the same eight branches, each at the top of a method that
matters; a test that set `_testMode` skipped all of the following:

- **Constructor options** (`_testMode`, `_mockVersion`, `_mockFacts`,
  `_mockExitCode`) — the fake itself, shipping in production code.
- **`DetectVersion`** — the `execSync` `--version` probe and its error path.
  Never exercised by any test until now; tests now point `CODEX_PATH` /
  `CLAUDE_PATH` at a version-printing `.cmd` fixture
  (`tests/fixtures/version-shim.js`) and the real probe runs.
- **`Start`** — executable resolution, temp-dir lifecycle, argv construction
  (`buildArgv` + `buildCmdInvocation`), the spawn call and its options, stream
  wiring, the `exit`/`error`/`stdin.error` handlers, and the sync-failure
  temp-dir cleanup.
- **`SendPrompt`** — the no-child guard, the `started` fact, stdin write+end.
- **`Observe`** — the whole drain: live-fact queue, park-with-recheck
  (`LIVE_DRAIN_RECHECK_MS`), exit wait, bounded stream drain, stderr failure
  classification, final line-buffer flush, ordered terminal facts. This is the
  code that needed the four fixes in `docs/engineering/lessons.md` §3.
- **`CollectResult`** — the real result path: codex's `-o` file read with
  empty/oversize/missing classification; claude's `_collectResultFromEvents`
  (text/usage/session/`result_status`).
- **`LiveSmoke` / `LiveSmokeRequest`** — the version probe and `runAdapterSmoke`.

Shared: `_resolveExitCode` in `process-lifecycle.js` honoured `_mockExitCode`.
Removing the constructor option would have turned that branch into a live bug
(`undefined !== null` → returns `undefined`), so the branch was removed in the
same change; it was production-dead before (nothing ever set the option in
production).

### The seam

`_spawn(invocation)` lives in `adapters/shared/process-lifecycle.js`, so both
adapters inherit it. The default is exactly today's call:
`spawn(invocation.command, invocation.args, invocation.options)` — the
`options` object is the one the adapter assembled in `Start()` (cwd, stdio,
windowsHide, windowsVerbatimArguments, and claude's env), passed through
verbatim. A test overrides it on the instance with a scripted fake child.

### The three new tests (criterion D)

`tests/adapters/scripted-child.test.js`, run against **both** adapters through
the seam, so framing, drain, exit ordering and classification execute for real:

1. **Split partial line** — two `stdout` chunks tearing one JSON value
   (`'{"type":"assistant_text","content":"hel'` + `'lo"}\n'`) frame into
   exactly one `assistant_text` fact. Also asserts the first chunk sits
   unparsed in `_lineBuffer` before the newline arrives.
2. **Output after exit** — `exit` fires, then stdout data arrives, then the
   streams close. The bounded drain waits on stream close and the final
   line-buffer flush delivers the fragment; for claude, `CollectResult` also
   carries the drained text.
3. **Missed wake-up** — the drain parks, its stored resolver is discarded (the
   original bug), then the child exits; completion comes from the refed
   re-check timer, never from the (dropped) wake.

Each of these would have been skipped by the `_testMode` branch.

### Discoveries

- The ticket's Agent-check grep `grep -rn "spawn("` matches the seam's own
  name `_spawn(` at every call site. The real check is that the only actual
  `child_process.spawn` call is inside the default `_spawn` in
  `process-lifecycle.js` — verified, one occurrence.
- `DetectVersion` and `LiveSmoke` still use `execSync`, not the seam: the seam
  is at the `spawn` boundary only, and those methods were left exactly as they
  were (criterion F).
- The contract suite for codex now constructs the **real** adapter (previously
  test-mode) and runs its 14 assertions unchanged; `tests/contract/suite.js`
  itself is untouched and its source is byte-identical (parity gate's
  adapter-name scan still passes).
