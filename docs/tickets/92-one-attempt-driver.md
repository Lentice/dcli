# 92 — One attempt driver: the detached worker and the foreground path stop being two copies

**Status:** done
**Blocked by:** —
**Tier:** Correctness and trust. The foreground and background spellings of the same command have
already drifted into four observable behavioural differences. Every future timeout, cancellation or
terminal-state fix has to be made twice, and history shows the second copy gets forgotten.
**Filed from:** architecture review, 2026-08-10 (three independent reviewers ranked this #1; the
duplication and every divergence below were verified by hand against the tree at `adcbac1`).

---

## Symptom / Goal

`dcli run` and `dcli submit` are the same job, executed in the foreground and in a detached worker.
They are driven by two separate implementations of one algorithm, and those implementations no longer
agree:

| Behaviour | `core/commands/attempt.js` (foreground) | `core/commands/worker.js` (detached) |
|---|---|---|
| Worktree snapshot finalize, injected into terminal detail | present | **absent** — the file contains no `worktree` reference |
| `fallbackSessionId` when the backend reports no session id | present | **absent** |
| `cancel.request` file watcher | **absent** | present |
| `kill_skipped` recorded on hard timeout | **absent** | present |

Observable consequences today:

- A foreground `dcli run` cannot be cancelled by `dcli cancel`, because only the worker watches
  `cancel.request`.
- A `timed_out` foreground job records no `kill_skipped`, so it is indistinguishable from a job whose
  process tree was provably killed. That is the exact ambiguity `docs/engineering/lessons.md` #5 exists
  to prevent.
- A backgrounded implement-mode job records no worktree result commit.

The goal is one driver module that both paths call, with the remaining differences expressed as
parameters rather than as two bodies of code.

## Root cause

Commit `d0f4f9b refactor(commands): run/resume/submit share one attempt driver` unified three commands
onto `runAttempt()` and left the fourth path — the detached worker — as a full second copy. The two
files still contain the same algorithm: hard-timeout rung walk, `Observe` loop, `persistStartedFact`,
`process_exited` branch, `persistCollectedResult` / `persistBackendEvents` / `persistFindings`,
`classifyTerminalFailure`, terminal `journalTransition`, `tryDisposeAdapter`, slot release,
`terminalExitCode`.

Verbatim duplication, verified:

```
core/commands/attempt.js:368   const HARD_TIMEOUT_ERROR = Symbol('hard_timeout');
core/commands/worker.js:543    const HARD_TIMEOUT_ERROR = Symbol('hard_timeout');

core/commands/attempt.js:370   function raceObserve(iterator, deadline) {
core/commands/worker.js:545    function raceObserve(iterator, deadline) {
```

The two `raceObserve` copies are not identical: the worker's has `throw()` handling the foreground's
lacks. That is the drift this ticket exists to end.

Further duplicated pairs: `cancelThroughRungs` (`attempt.js:103-112`) vs `requestCancelRungs`
(`worker.js:276-285`); the `result_persistence_failed` block (`attempt.js:217-237` vs
`worker.js:387-403`); the observe-ended terminal journal (`attempt.js:301-328` vs `worker.js:514-540`).

## Binding constraints — quoted, do not go looking for them

From `docs/design-spec.md` §7, the exit codes this driver produces and must not change the meaning of:

> | `10` | Backend/provider execution failed (see `failure_reason`) |
> | `11` | No usable assistant result |
> | `24` | Job hard timeout; process tree killed |

From `docs/design-spec.md` §13, "Deadlines — every blocking boundary is finite": the `Observe`
deadline race, the dispose bound and the drain bound are all load-bearing. The refed-timer property of
`raceObserve` is what stops the process exiting 0 mid-drain; do not replace `setTimeout` with
`unref()`-ed timers.

From `docs/engineering/lessons.md`: a `timed_out` terminal state must carry evidence of what was
actually killed. `kill_skipped` is that evidence.

Ticket 78 is **closed, not implemented**: backend process trees are never contained, so hard-timeout
escalation legitimately ends at the rung walk and records `kill_skipped: 'not_contained'`. Do not wire
containment as part of this ticket, and do not remove the `kill_skipped` record.

## Files to read and trace first

- `core/commands/attempt.js` — `runAttempt()` and its ~15-parameter interface; the worktree finalize
  block, `fallbackSessionId`, `raceObserve`, `cancelThroughRungs`.
- `core/commands/worker.js` — `main()`, the second `raceObserve`, `requestCancelRungs`, the
  `cancel.request` watcher, `kill_skipped`, and `finish()` which writes the completion sentinel.
- `core/commands/run.js`, `core/commands/resume.js` — the two current `runAttempt()` call sites; what
  they pass and what they do with the return value.
- `core/commands/submit.js` — writes `params.json`; the worker reads it. Whatever the driver needs must
  be reachable from there.
- `core/reducer.js` — the engine owns terminal state. The driver feeds it facts; it must not decide.
- `core/result-artifact.js` — `persistCollectedResult`, `persistBackendEvents`, `persistFindings` and
  their required ordering (result before terminal journal).
- `tests/core/worker-*.test.js`, `tests/contract/` — the regression net. These must stay green
  unchanged for as long as possible during the merge.

## What to build

### 1. `core/commands/attempt-driver.js`

Export one function:

```js
driveAttempt({
  store, adapter, repoKey, repoRoot, jobId, attemptNum,
  prompt, request, worktree, hardTimeoutSec,
  cancelSignal, onStarted, fallbackSessionId, extraDetail,
}) -> { text, jobId, envelope, exitCode, terminalState }
```

It owns, once: the hard-timeout rung walk, the bounded `Observe` loop, `persistStartedFact`, the
`process_exited` branch, result/events/findings persistence with its ordering, the
`result_persistence_failed` path, `classifyTerminalFailure`, the terminal `journalTransition`,
`tryDisposeAdapter`, admission slot release, and `terminalExitCode`.

`cancelSignal` is a small object exposing `isCancelled()` (and, if a watcher is used, `dispose()`).
The worker passes one backed by the `cancel.request` poller it already has; the foreground passes one
backed by the **same** poller, so `dcli cancel` starts working on foreground jobs.

### 2. `core/commands/worker.js` shrinks to a process host

It keeps only: environment validation, `params.json` / prompt load, admission acquisition, adapter
load, the launch-identity journal, the call to `driveAttempt`, and `finish()` writing the completion
sentinel from the returned `terminalState`. Target: roughly 150 lines.

### 3. `runAttempt()` becomes a thin wrapper or is deleted

`run.js` and `resume.js` call `driveAttempt` directly, passing a never-set `cancelSignal` only if the
watcher cannot be shared — but sharing it is the intent.

### 4. Both paths gain the behaviour the other had

- Worker: worktree snapshot finalize into terminal detail, and `fallbackSessionId`.
- Foreground: the `cancel.request` watcher, and `kill_skipped` on hard timeout.

Adding `worktree_result_commit` and `kill_skipped` where they were previously absent is **append-only**
and therefore permitted by invariant 4. No field changes meaning.

### 5. One `raceObserve`

The driver's copy keeps the worker's `throw()` handling — the stricter of the two.

## Non-goals

- **Wiring containment.** Ticket 78 closed that by decision; reopening it here would double this
  ticket's size and its risk.
- **Unifying job *creation*** (`prepareBackend` → `acquireSlot` → `createJob` → …). That is ticket 95;
  keeping the two seams separate is what keeps each under two days.
- **Extracting generic bounded-wait primitives** (`withDeadline`, `pollUntil`). Once there is one
  `raceObserve` the duplication that motivated it is gone; a primitives module can be argued for later
  on its own merits.
- **Changing any exit code, `status.json` field, journal kind or stdout byte.** This is an
  equivalence-preserving merge plus four named behaviour additions.

## Acceptance criteria

- [ ] **A.** `core/commands/attempt-driver.js` exists and is the only definition of `raceObserve` and
  `HARD_TIMEOUT_ERROR` in `core/`.
- [ ] **B.** `core/commands/worker.js` no longer contains an `Observe` loop, a terminal
  `journalTransition`, or result persistence; it calls `driveAttempt`.
- [ ] **C.** A foreground `dcli run` responds to `dcli cancel` — the job reaches `cancelled`, not
  `done` or `timed_out`.
- [ ] **D.** A foreground job that hits its hard timeout records `kill_skipped` in the terminal detail,
  with the same value the worker path records.
- [ ] **E.** A backgrounded `--mode implement` job records the worktree result commit in its terminal
  detail, as the foreground path already does.
- [ ] **F.** A backgrounded job whose backend reports no session id records the `fallbackSessionId`.
- [ ] **G.** Unit tests drive `driveAttempt` in-process with a fake adapter and an injected
  `cancelSignal`, covering: hard timeout, cancellation, and result-persistence failure. None of the
  three spawns a detached process.
- [ ] **H.** `tests/contract/` and the existing `tests/core/worker-*.test.js` pass unchanged.
- [ ] **Z.** `npm run check` green; `README.md`, `docs/reference/*` and `integration/source/*` updated in
  the same commit — foreground cancellation becoming supported is user-visible and agent-visible.

## Agent checks

```bash
# One raceObserve, one HARD_TIMEOUT_ERROR in core/.
grep -rn "function raceObserve\|HARD_TIMEOUT_ERROR = Symbol" core/
# expect: exactly two lines, both in core/commands/attempt-driver.js

# The worker no longer owns terminal state.
grep -n "journalTransition\|persistCollectedResult\|classifyTerminalFailure" core/commands/worker.js
# expect: no match for persistCollectedResult or classifyTerminalFailure

# No backend name leaked into the new driver (invariant 1).
grep -niE "codex|opencode|claude" core/commands/attempt-driver.js
# expect: nothing

# The worker shrank.
wc -l core/commands/worker.js
# expect: well under 300 (was 646)

npm run check
# expect: green
```

## Handoff

**Extra reading, beyond `AGENTS.md` and `00-onboarding.md`** — these and nothing else:
`docs/engineering/lessons.md` (all of it; §3 and §5 are this ticket's subject),
`docs/design-spec.md` §13 (deadlines) and §14 (cancellation rungs),
`docs/engineering/windows-spawning.md` only if you touch process termination.

**Implementation order.** This is an equivalence-preserving merge, so the order matters more than usual:

1. **Capture the baseline first.** Before changing anything, write a *characterization* test that runs
   one job through the foreground path and one through the worker path with the fake adapter, and
   snapshots both journals to fixture files. This is your safety net — it must stay byte-identical
   except for the four named additions.
2. Write the failing tests for the four divergences (criteria C–F). Verify red. Do not fix them yet.
3. Create `core/commands/attempt-driver.js` by **moving** `runAttempt`'s body verbatim. No edits.
   Point `run.js` and `resume.js` at it. Run the suite — green, with zero behaviour change.
4. Add the `cancelSignal` parameter, backed by the worker's existing `cancel.request` poller. Wire the
   worker's poller into it. Run the suite.
5. Replace `worker.js`'s body with a call to `driveAttempt`. Delete its `raceObserve`,
   `HARD_TIMEOUT_ERROR`, `requestCancelRungs`, terminal journalling and result persistence. Keep the
   worker's `throw()` handling by carrying it into the driver's `raceObserve` in the *previous* step.
6. Now the four divergence tests from step 2 go green, because both paths share one body.
7. Move the worker-only unit tests in-process against `driveAttempt` (criterion G).

**Running tests while you work:**

```bash
node tests/core/worker-liveness.test.js     # one file, directly
npm test                                    # quick suite
npm run check                               # lint + full suite — required before commit
```

**Traps specific to this ticket:**

- `raceObserve`'s `setTimeout` must stay **refed**. An `unref()`-ed timer lets the process exit 0
  mid-drain. `docs/engineering/lessons.md` §3 is four separate fixes for exactly this.
- The worker's `finish()` writes the completion sentinel. The sentinel must be written **after** the
  terminal journal entry, never before — the reducer reads it as positive evidence the owner is gone.
- `kill_skipped: 'not_contained'` is correct and must be preserved. Ticket 78 closed containment by
  decision; the value is honest, not a bug.
- Adding `cancelSignal` to the foreground path makes `dcli cancel` work on `run` for the first time.
  That is user-visible: it belongs in `README.md` and `integration/source/*` in this commit.

**Commit message:**

```
ticket 92: one attempt driver for foreground and detached execution
```

## Notes

**Characterization baseline.** `tests/core/attempt-driver.test.js` section 1 runs one job through the
foreground path (`executeRun`) and one through a real spawned worker (same fake-adapter script), then
asserts the two journals are byte-identical after normalizing only caller/run-volatile fields
(`at`, timestamps, `worker_pid`, `worker_identity`, `execution_token`, `backend_pid`, `job_id`,
`root_job_id`, `repo_key`, `repo_root`) and dropping `heartbeat` lines. The normalized foreground
journal is snapshotted to `tests/fixtures/attempt-driver/baseline.json`; the test fails if the
current output drifts from that fixture. It was captured pre-merge and held byte-identical through the
merge, which is what proves the merge was equivalence-preserving on the ordinary-success path.

**How the four divergences were reconciled** (all in `core/commands/attempt-driver.js`):

- *Worktree finalize:* `finalizeWorktreeSnapshot()` moved into the driver and spread into every
  terminal detail (`timed_out`, `result_persistence_failed`, `process_exited`, observe-ended). The
  worker calls `driveAttempt` with `worktreePath: null`, so it contributes nothing there today.
- *`fallbackSessionId`:* the driver's `resolveSessionId` = `collected.backend_session_id ||
  fallbackSessionId || null`. The worker passes `params.fallbackSessionId || null`; `submit` now writes
  `fallbackSessionId: parentStatus.backend_session_id` into `params.json` when `--resume` is used, so a
  fork of a parent session keeps that provenance. Criterion F is asserted in-process on `driveAttempt`.
- *`cancel.request` watcher:* the driver polls the injected `cancelSignal` on a 2 s cadence
  (`checkCancelRequest`, mirroring the worker's old loop) and, on first true, runs the rung walk —
  including while `iter.next()` is pending, which is the only way a hanging backend breaks. The shared
  factory `createCancelSignal({ jobDir })` backs both the worker and the foreground (`run`/`resume`
  now pass one), so `dcli cancel` works on foreground jobs for the first time.
- *`kill_skipped` on hard timeout:* the driver's single `finishTimedOut` journals
  `kill_skipped: 'not_contained'` unconditionally. Discovery: the old worker's value was racy — if
  `raceObserve` won the deadline race against its hard-timeout timer, `hardTimeoutKillSkipped` was
  still null and the journal recorded `kill_skipped: null`. The driver makes it deterministic.

**One `raceObserve` / one `HARD_TIMEOUT_ERROR`.** Both live only in `attempt-driver.js`; the driver's
copy keeps the worker's stricter `throw()` forwarding. The per-iteration `setTimeout` stays **refed**
(lessons.md §3 — an `unref()`-ed timer lets the process exit 0 mid-drain).

**Other deliberate merge choices (not among the four named additions):**
- On hard timeout the driver flushes partial result/events/findings before the `timed_out` journal
  (the worker's behaviour; the foreground gains it).
- Start-phase and observe-loop failures route through the foreground's `abandon()` (`failed` /
  `adapter_start_failed`, exit 18), replacing the worker's `adapter_error`/`observe_error` +
  `finish(1)`. No test asserted the old worker values; a throwing `driveAttempt` is caught by the
  worker's `main().catch` (crash sentinel, exit 1).
- The worker lost its one-shot startup heartbeat; the driver's 5 s heartbeat cadence (which the
  foreground already used) covers liveness, within the reducer's 15 s staleness threshold.

**Worker shape.** `worker.js` went from 646 to 296 lines: env validation, params/prompt load,
admission + queueing, adapter load/validate, `attempt_created` + `running` identity journals,
`driveAttempt` call, and `finish()`/sentinel plus the crash path. It no longer contains `raceObserve`,
`HARD_TIMEOUT_ERROR`, `requestCancelRungs`, result persistence, or a terminal `journalTransition`.

**Verified facts that held.** The four named additions are the only journal changes on their
respective paths; `tests/contract/` and every `worker-*.test.js` pass unchanged. Exit codes,
`status.json` fields, journal kinds and stdout bytes are unchanged.
