# Ticket 79 — `Observe()` misses its wake-up, so every codex and claude job silently exits 0

**Status:** landed 2026-07-31 — verified end-to-end, not only by test:
`dcli-codex run "Reply with exactly the word PONG…"` → `PONG`, exit 0, 5 bytes, job `done`,
`result_bytes: 4`, `command_exit_code: 0`, with `result.md` + `backend-events.jsonl` + `findings.json`
persisted. `dcli-claude run` likewise returns `PONG`, exit 0. Before: exit 0, **zero bytes**, job frozen
in `running`.
**Tier:** blocker — this sits in front of every other open ticket
**Blocks:** all delegated verification and all per-phase dogfooding review (AGENTS.md "Dogfooding")

---

## Symptom, as observed

```
$ dcli-codex run --hard-timeout-sec 120 "Reply with exactly PONG."
REAL_EXIT=0
stdout: 0 bytes
stderr: 0 bytes
elapsed: 16.4s
```

The job is left in `running` forever; its journal stops at seq 3 (`attempt_state_changed → running`).
No `backend-events.jsonl`, no result, no `failure_reason`.

**Exit code 0 with zero bytes is the worst available failure**: an agent parsing stdout reads it as
"succeeded, result empty". This is AGENTS.md mistake #7 (a parse/absence failure must never read as a
clean result) reached by a different route.

The backend itself is healthy. `codex exec --sandbox read-only` returns `PONG` in seconds
(`codex-cli 0.146.0`), and the adapter's own `DetectVersion()` reads that version correctly — so this
is entirely inside dcli.

## Root cause

`adapters/codex/adapter.js`, `_drainLiveQueue()` parks on a bare promise that only the **stdout `data`**
handler resolves:

```js
while (!this._observedExited) {
  if (this._liveFacts.length > 0) yield this._liveFacts.shift();
  else await new Promise((resolve) => { this._liveFactsResolve = resolve; });
}
```

The child's `exit` and `error` handlers set `_observedExited = true` and call `_exitResolve()`, but
**never call `_liveFactsResolve`**. The `while` condition is only re-evaluated *after* the parked
promise settles, and nothing settles it. Classic missed wake-up.

Then the second half of the failure: once the child's pipes close and `ProcessWrap` is released, the
process has **no refed libuv handle left**, so Node drains the event loop and **exits 0** in the middle
of the `for await`. No result, and no error either.

Instrumented reproduction (`process.getActiveResourcesInfo()` sampled every 2.5 s):

```
[+450ms]  started pid=39008                            <- real codex child
[+914ms]  fact started                                 <- real fact observed
[+2515ms] ["PipeWrap","PipeWrap","ProcessWrap","PipeWrap","PipeWrap"]
[+7532ms] ["PipeWrap","ProcessWrap","PipeWrap","PipeWrap"]
          stdoutReadable=false stdoutDestroyed=true exitCode=null observedExited=false
[+7549ms] EXIT 0   observedExited=true  facts=2  live=0
```

`_waitForExit()`'s doc comment claims it is "Deliberately a REFED (not unref'd) wait". **That comment is
false**, and it is why the defect looks pre-considered: a `new Promise` never refs the libuv loop; only a
real handle does. Correct the comment as part of the fix — a wrong comment here will re-create the bug.

## Scope: both stdio adapters, identical code

- `adapters/codex/adapter.js` — handlers at `:401-408`, drain at `:455-464`
- `adapters/claude/adapter.js` — handlers at `:283-290`, drain at `:335-344` — **byte-identical shape**

`adapters/opencode/adapter.js` uses an HTTP transport and has neither symbol, so it is out of scope for
this ticket. It is *also* not delivering results (30 min of real work, `result_bytes: 0`, `heartbeat_at`
written exactly once at T+1 s, no `backend-events.jsonl`) — that is a separate defect; file it after this
one lands so the two are not confounded.

## Why the suite is green

`Observe()` opens with:

```js
if (this._testMode) { for (const fact of this._mockFacts) yield { ...fact }; return; }
```

Every adapter test sets `_testMode`, so `_drainLiveQueue`, `_waitForExit`, and the `exit`/`error`
handlers' interaction with them are executed by **nothing**. This is verbatim the cliff AGENTS.md
records under "Testing rules learned the hard way", whose worked example is the previous
`ReferenceError: child is not defined` in *this same file*. Same file, same short-circuit, second time.

`doctor` reporting all-green is the same blindness from the other side: it verifies the state root is
writable, the containment helper exists, git is available, and the repo path resolves — and it has
never run a live smoke (`live_smoke_timeout_sec: null`). A doctor that never starts a backend cannot
report that starting a backend does not work.

## Acceptance criteria

- [x] **A. The wake-up is not missable.** The child `exit` and `error` handlers wake *every* waiter, not
  just `_exitResolve`. Prefer one private `_wakeObservers()` called from the stdout `data` handler and
  from both terminal handlers, so a future third waiter cannot be forgotten.
- [x] **B. A silent exit 0 is structurally impossible while observing.** The parked wait re-checks its
  condition on a bounded interval backed by a **refed** timer, so the event loop cannot empty while
  `Observe()` is still draining. A missed wake-up must degrade to a short delay, never to a hang and
  never to process evaporation.
- [x] **C. The false comment on `_waitForExit` is corrected**, stating what actually keeps the loop alive.
- [x] **D. Tests that do not take the `_testMode` short-circuit** drive a real child through
  `Start → SendPrompt → Observe` and assert a `process_exited` fact is yielded. Both adapters.
  Each test carries its own bounded timeout so a regression fails loudly instead of hanging the suite.
  Fixture trees are terminated and verified in a `finally`.
- [x] **E. A test pins criterion B directly** by simulating a dropped wake-up (clear the stored resolver,
  then flip the exit flag) and asserting the drain still completes.
- [x] **F. `npm run check` green**; docs updated in the same commit.

## Notes

- Do **not** fix this by making `executeRun`'s hard-timeout timer refed. That would convert a silent
  exit-0 into a full hard-timeout wait for a job whose backend already finished — AGENTS.md mistake #1,
  the eight-hour incident, in miniature. The wake-up is the defect; fix the wake-up.
- Related but deliberately out of scope: `cli/dcli.js` constructs every adapter with
  `{ facts, exitCode, declaredRungs, capabilities }`, while the constructors read `_testMode` /
  `_mockFacts` / `_mockExitCode`. All four keys are silently discarded. Harmless today (it is why the
  real path runs at all), but `capabilities` being dropped on the floor is a latent defect. Separate
  ticket.
