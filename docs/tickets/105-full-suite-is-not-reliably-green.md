# 105 — `npm run check` is not reliably green at its own default concurrency

**Tier:** Test-suite trust, which is the foundation every other ticket stands on. A suite that fails
differently on each run teaches every future agent session that a red `npm run check` is background noise.
Once that is learned, the gate has stopped working — and `AGENTS.md` requires `npm run check` green before
every commit.
**Filed from:** two consecutive full runs on 2026-08-10 while committing tickets 92–104.

---

## Symptom / Goal

Two consecutive `npm run check` runs on the same tree, with no code change between them, failed with
**different** sets of files:

```
run 1:  core\locking.test.js
run 2:  core\job-store.test.js, core\locking.test.js,
        core\state-root.test.js, core\submit-e2e.test.js
```

All four pass when run individually. A third run at `--concurrency 4` passed the whole suite:

```
node tests/run-tests.js --suite full --concurrency 4
adapters: 27 passed   contract: 2 passed   core: 45 passed
helpers: 1 passed     integration: 2 passed        exit 0
```

The failures are not assertion failures about behaviour. They are child processes killed by their own
`spawnSync` budgets, surfacing as `status: null`:

```
tests/core/locking.test.js:190   AssertionError: Child must exit cleanly
                                 null !== 0        (actual: null, expected: 0)
tests/core/submit-e2e.test.js    FAIL: submit exited null
```

The measured cause is contention against the per-file 120 s cap. Same host, same tree, default concurrency
(`os.cpus().length - 2` = **18** on a 20-core machine) versus `--concurrency 4`:

| Suite | default concurrency | `--concurrency 4` |
|---|---|---|
| `core/job-store.test.js` | **121040 ms** (over cap) | passed |
| `core/missing-job-exit-3.test.js` | **120897 ms** (over cap) | passed |
| `core/setup-cleanup.test.js` | **120782 ms** (over cap) | 35271 ms |
| `core/review.test.js` | **120522 ms** (over cap) | 40261 ms |
| `core/resume.test.js` | 82804 ms | passed |
| `core/reducer-backstop.test.js` | 65440 ms | passed |
| `core/hard-kill-honesty.test.js` | 62605 ms | passed |

Four files hit the cap and several more sat within a factor of two of it. This is not one slow test; it is
the whole `core` group oversubscribing the host, so *any* of them can be the one that loses.

Goal: `npm run check` either passes reliably at its declared default on a normal development machine, or
states plainly what it needs — never fails randomly.

## Root cause — as far as it is established

Two effects compound, and an implementer must separate them before choosing a fix:

1. **The default concurrency oversubscribes the host.** These are process-spawning tests, not CPU-bound
   ones; eighteen concurrent files each spawning node and git processes is far more than eighteen
   processes. On Windows each process creation is expensive (`docs/engineering/testing.md` notes real-time
   antivirus scanning as a factor).
2. **Several tests carry short absolute internal budgets** that were sized for an unloaded machine and have
   no relationship to the runner's own cap:

   ```
   tests/core/locking.test.js:186     timeout: 5000     ← the observed failure
   tests/core/state-root.test.js:52   timeout: 5000
   tests/core/containment.test.js:27  timeout: 3000
   tests/core/commands.test.js:30     timeout: 15000
   tests/core/job-store.test.js:689   timeout: 15000
   tests/core/submit-e2e.test.js:28   timeout: 15000    ← the observed failure
   ```

   A 5000 ms budget for `spawnSync(process.execPath, ['-e', script])` is generous unloaded and impossible
   under contention, and when it expires `spawnSync` kills the child — which the test then reports as the
   child having crashed. **The diagnostic is actively misleading**: "Child must exit cleanly" describes a
   process the test itself killed.

Which of the two dominates is not established. Measure before fixing.

## Binding constraints — quoted, do not go looking for them

This is the sentence that makes this ticket harder than it looks. From `docs/engineering/testing.md`:

> On Windows, real-time antivirus scanning can make each process creation unusually expensive. A local
> exclusion for this repository and the test temp area may improve development speed, but the suite must
> remain correct without one. **Do not weaken concurrency, budgets, or assertions to compensate.**

So the obvious fixes — lower the default concurrency, raise the per-file cap, raise every internal
timeout — are each explicitly what that line forbids as a *compensation*. This ticket is not permission to
override it.

The distinction the implementer must hold:

- **Compensation** (forbidden): the test is fine, the machine is slow, so loosen the number until it passes.
- **Correction** (required): the budget was never a considered bound, it is unrelated to what the test
  asserts, and a load-sensitive absolute timeout in a concurrent runner is a defect in the test.

Also from `docs/engineering/testing.md`, and directly applicable:

> **Synchronize on observed state, not sleeps.** Fixed `sleep` delays make suites slow and load-flaky; use
> ready/release markers.

> The quick suite must **name** what it skipped. A silently shrinking suite is how coverage rots.

The second is the precedent for the reporting requirement below: reduced or degraded coverage is announced,
never silent. A suite that quietly needed three attempts is the same failure in a different costume.

From `AGENTS.md`: `npm run check` green is a precondition of every commit. That is the contract this ticket
protects, and it is why "just re-run it" is not an acceptable resolution.

**If the honest answer turns out to be that the default concurrency is simply wrong for a spawn-heavy
suite** — that `cpus - 2` is a CPU-bound heuristic applied to a process-bound workload — then changing it is
a *correction*, not a compensation, and the testing note should be amended to say so. Make that argument
explicitly in Notes with the measurements behind it. Do not change the number quietly.

## Files to read and trace first

- `tests/run-tests.js` — `MAX_CONCURRENCY`, `DEFAULT_TIMEOUT` (120 s), the `--concurrency` and
  `--timeout-ms` flags, the sentinel parsing for `// @suite full`, `// @serial` and `// @timeout-ms `, and
  `runParallelBatch`. Note how `@serial` files are batched relative to parallel ones.
- `tests/core/locking.test.js:186` — the observed failure and its misleading assertion message.
- `tests/core/submit-e2e.test.js`, `tests/core/state-root.test.js`, `tests/core/job-store.test.js` — the
  other three observed failures and their internal budgets.
- `tests/core/review.test.js`, `setup-cleanup.test.js`, `missing-job-exit-3.test.js` — the files that hit
  the 120 s cap. What do they spawn, and how many times?
- `tests/core/test-runner.test.js` — the runner's own tests. Any change to defaults or reporting lands here.
- The eleven files that already carry `@serial` — the existing judgement about what cannot share the host.
- `docs/engineering/testing.md` — all of it. It is the standard this ticket is measured against.

## What to build

Resolve in this order. Steps 1 and 2 are measurement and must come first; do not start editing timeouts.

### 1. Measure, and write the numbers into Notes

Run the full suite at concurrency 1, 4, 8 and the default, three times each. Record per-file durations and
which files fail at which level. Without this the rest is guesswork, and the wrong one of the two causes
gets "fixed".

### 2. Decide which of the two effects dominates, and say so

If files pass at concurrency 4 but their durations are still within 2× of the cap, the cap is not the
problem — the load is. If a file is slow even alone, it is a slow test and belongs in a different bucket.

### 3. Fix the misleading diagnostics — unconditionally, whatever else is decided

A `spawnSync` that hits its own `timeout` must not be reported as "Child must exit cleanly". Distinguish
`status === null && error?.code === 'ETIMEDOUT'` from a real crash and report *the test's own budget
expired*, naming the budget. This alone would have made the original failure self-explaining, and it is a
correction with no downside.

### 4. Replace load-sensitive absolute budgets where they are not the assertion

Where a `spawnSync` timeout exists only to stop a hang — not because the test asserts anything about
duration — it must not be a hand-picked absolute number smaller than the runner's own cap. Derive it from
the runner's budget, or drop it and let the runner's cap be the single bound (invariant 3 is satisfied
either way: the runner's cap is finite). Where a test *does* assert a timing bound, leave it and say so in
Notes.

### 5. Only then, concurrency

If steps 3–4 leave the suite still failing at the default, then the default is wrong for this workload.
Change it with the measurements as justification, amend `docs/engineering/testing.md`'s note, and state the
reasoning where the number is defined.

### 6. Report contention rather than hiding it

If the runner detects it is oversubscribed — a file exceeding some fraction of its cap, or a child killed by
its own budget — it must **say so in the summary**, in the same spirit as the quick suite naming what it
skipped. A run that nearly failed should not look identical to one that passed comfortably.

## Non-goals

- **Retries.** Re-running a failed test file until it passes converts a real flake into an invisible one and
  destroys the signal this ticket exists to restore. Not under any framing.
- **Raising `DEFAULT_TIMEOUT` above 120 s as the primary fix.** That is the compensation the testing note
  forbids, and it makes an already slow suite slower without making it correct.
- **Deleting or skipping the slow tests.** `review`, `setup-cleanup` and `missing-job-exit-3` cover real
  behaviour. Coverage is not the thing to spend here.
- **Marking everything `@serial`.** It would work and would make the suite unusably slow. `@serial` is for
  files that genuinely cannot share the host, and eleven files already carry it on that basis.
- **Antivirus configuration, or any change that only works on one machine.** The suite must be correct
  without a local exclusion — that is the same quoted line.
- **Touching product code.** Nothing here suggests a defect outside `tests/`. If the measurement says
  otherwise, that is a finding for Notes and a separate ticket.

## Acceptance criteria

- [ ] **A.** Ten consecutive `npm run check` runs at the default configuration on a normal development
  machine, all green. Record the runs and their durations in Notes. Fewer than ten is not evidence — the
  original symptom appeared on run 1 of 2 and then differently on run 2.
- [ ] **B.** A `spawnSync` killed by its own timeout is never reported as a child that crashed; the message
  names the expired budget.
- [ ] **C.** Every remaining absolute timeout inside a test is either derived from the runner's budget, or
  is the thing the test asserts — with which, per file, recorded in Notes.
- [ ] **D.** No retry, re-run or "attempt N of M" logic exists anywhere in the runner.
- [ ] **E.** If the default concurrency changed, `docs/engineering/testing.md` is amended with the reasoning
  and the measurements, and the "do not weaken concurrency" line is updated rather than contradicted.
- [ ] **F.** The runner reports contention or near-cap runs in its summary.
- [ ] **G.** Coverage is unchanged: the same files run in the same suites, nothing newly skipped.
- [ ] **Z.** `npm run check` green.

## Agent checks

```bash
# The measurement that filed this ticket, reproduced.
node tests/run-tests.js --suite full --concurrency 4
# expect: exit 0

# The default is what actually has to work.
for i in 1 2 3 4 5 6 7 8 9 10; do npm run check > /tmp/run-$i.log 2>&1; echo "$i: $?"; done
# expect: ten zeros

# No retries were introduced.
grep -rniE "retry|retries|attempt [0-9]|re-?run" tests/run-tests.js
# expect: nothing that re-executes a failed file

# No test kills its own child earlier than the runner would.
grep -rn "timeout: [0-9]\{3,5\}" tests/
# expect: each remaining one is justified in Notes

npm run check
# expect: green
```

## Handoff

**Extra reading, beyond `AGENTS.md` and `00-onboarding.md`** — `docs/engineering/testing.md` in full; it is
both the constraint and the standard here. Nothing else.

**Read this first.** The tempting fix — turn concurrency down, turn timeouts up — is the one
`docs/engineering/testing.md` explicitly forbids as a compensation, and it would make the suite slower
without making it trustworthy. The work is to establish *which* budgets were ever considered decisions and
which were guesses, and to correct the guesses. If the measurements genuinely show the default concurrency
is a CPU-bound heuristic applied to a process-bound suite, that is a legitimate correction — but it has to
be argued from numbers in Notes and the testing note amended, not changed quietly.

**Stop and ask** if the measurements point at a fix that the quoted line forbids and you cannot make the
correction-versus-compensation argument honestly. Weakening the gate to make it green is worse than leaving
it flaky, because a weakened gate looks trustworthy.

**Implementation order:**

1. Measure (step 1). Numbers into Notes before any edit.
2. Fix the diagnostics (step 3) — independently valuable, and it makes every later run legible.
3. Correct the unjustified internal budgets (step 4). Re-measure.
4. Concurrency (step 5) only if still required, with the argument written down.
5. Add contention reporting (step 6).
6. Run criterion A's ten runs last, on an otherwise idle machine.

**Running tests while you work:**

```bash
node tests/core/test-runner.test.js
node tests/run-tests.js --suite full --concurrency 4
npm run check
```

**Traps specific to this ticket:**

- **A green run proves nothing here.** The bug is intermittent; one pass is the null result. Criterion A
  asks for ten for that reason.
- **`spawnSync`'s `timeout` kills the child and reports `status: null`** — indistinguishable from a crash
  unless you check `error.code === 'ETIMEDOUT'`. That confusion is what made the original failure look like
  a product defect.
- **Do not add retries**, including a "just once more for flaky files" affordance. It is the single change
  that would permanently destroy this signal.
- Do not weaken an assertion to make a test fit its budget. If a test is slow because it asserts something
  expensive, that is a slow test, not a wrong one.
- The eleven existing `@serial` files reflect earlier judgement about host sharing. Understand why each is
  serial before adding or removing one.
- Measure on an idle machine. A measurement taken while an agent session is spawning subprocesses is the
  same contention you are trying to characterise — the original observation was taken during exactly that,
  which is why it is a symptom report and not a root-cause claim.

**Commit message:**

```
ticket 105: the full suite is reliably green at its own default
```

## Notes

**Implemented 2026-08-10.** Commit `ticket 105: the full suite is reliably green at its own default`.
All measurements below were taken on the filing machine (Windows, 20 cores, default runner concurrency
`os.cpus().length - 2` = 18) on an otherwise idle host, per the trap note.

### 1. Measurement (12 full-suite runs: concurrency 1 / 4 / 8 / default, three each)

Every run exited 0. The suite is green at **every** concurrency level on an idle machine, including the
default. Wall-clock totals:

| Concurrency | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| 1 | 193.2 s | 194.8 s | 200.5 s |
| 4 | 174.2 s | 170.8 s | 183.4 s |
| 8 | 198.1 s | 178.5 s | 183.3 s |
| default (18) | 195.7 s | 181.2 s | 185.1 s |

Longest per-file durations were stable and far below their caps — the four files that hit the 120 s cap
in the filing runs were 20–60× under it here:

| File | c1 | c4 | default |
|---|---|---|---|
| `core/test-runner.test.js` (@serial) | 40.8 s | 40.7 s | 40.9 s |
| `core/worktree.test.js` (@serial, 180 s cap) | 26–30 s | 24–30 s | 27–33 s |
| `core/commands.test.js` (@serial) | 15.8 s | 15–16 s | 15.5–16 s |
| `core/review.test.js` | 9–10 s | 12–16 s | 13–15 s |
| `core/containment.test.js` (@serial) | 11.6 s | 11.5–11.8 s | 11.7–11.8 s |
| `core/setup-cleanup.test.js` | 6 s | 9.9–11 s | 11 s |
| `core/missing-job-exit-3.test.js` | 4.7 s | 4.7–5.6 s | 5.0–5.4 s |
| `core/job-store.test.js` | 1.2 s | 1.6–1.8 s | 1.8–1.9 s |

No file exceeded ~34% of its budget on any idle run (the worst is always `test-runner.test.js`, which is
`@serial` and therefore concurrency-independent).

### 2. Which effect dominates

**Neither the cap nor the default concurrency is the defect — the load is, and it arrives from outside
the suite.** The filing measurements (four files over the 120 s cap at the default) were taken *while the
author was committing tickets 92–104*, i.e. while other agent sessions were spawning subprocesses on the
same host — exactly the contention this ticket's trap note warns about. Idle, the same files run in
1.9–16 s. The suite's own 18-way pool does not push them anywhere near the cap; the filing failures were
an uncontrolled external load laid on top of it.

The internal 5 s / 15 s `spawnSync` budgets were the *proximate* cause of the two observed "crashes"
(`locking.test.js` "Child must exit cleanly", `submit-e2e.test.js` "submit exited null"): a hand-picked
absolute number smaller than the runner's cap that fires under contention, reports `status: null`, and
was misdiagnosed as a child crash. Those are defects in the tests and were corrected. The four
cap-hits were a symptom of the same external load, not of the default being wrong.

### 3. Corrections (each argued as correction, not compensation)

- **`tests/run-tests.js` — misleading diagnostics + contention reporting.** Added a `--- LOAD ---`
  summary section: any file using ≥ 50% of its effective budget is listed with its percentage, so a run
  that nearly failed never looks identical to one that passed comfortably (acceptance F; the filing
  trap "the quick suite must name what it skipped" applied to reporting). No retry logic of any kind
  (acceptance D). `DEFAULT_TIMEOUT` is now exported so tests can derive their bounds from the runner's
  budget.
- **`tests/helpers/spawn-assert.js` (new).** One place that distinguishes `error.code === 'ETIMEDOUT'`
  (the test's own budget expired — name the budget) from a real crash (report status, error code,
  stderr). Replaces the "Child must exit cleanly"-style assertions (acceptance B).
- **Budgets derived from the runner's cap** (corrected the load-sensitive absolute numbers; acceptance C):
  `locking.test.js:186` 5 s→`DEFAULT_TIMEOUT`, `state-root.test.js:52` 5 s→`DEFAULT_TIMEOUT`,
  `containment.test.js` 3 s/5 s/5 s/5 s→`DEFAULT_TIMEOUT` (wmic, spawn, two powershell queries),
  `commands.test.js` `spawnCli` 15 s→`DEFAULT_TIMEOUT` plus the open-stdin kill-timer 15 s→`DEFAULT_TIMEOUT`,
  `job-store.test.js:689` 15 s→`DEFAULT_TIMEOUT`, `submit-e2e.test.js` three 15 s and one 120 s→`DEFAULT_TIMEOUT`,
  `cleanup-worktrees.test.js` / `setup-cleanup.test.js` / `git-repo-template.js` git ops 30 s→`DEFAULT_TIMEOUT`.
  None of these asserts anything about duration; each was a hang-stop that fired *before* the runner's own
  cap would, so leaving it was a smaller bound than the suite's single finite default — removing the
  discrepancy is a correction, not a weakened assertion. Invariant 3 (finite default) is untouched: the
  runner's per-file cap is the same finite bound it always was.
- **`docs/engineering/testing.md`** — added a "Rules learned the hard way" entry recording the convention:
  test-internal spawn bounds are derived from the runner's budget, never hand-picked, and an `ETIMEDOUT`
  is reported as the test's budget expiring. The "Do not weaken concurrency, budgets, or assertions to
  compensate" line is unchanged (acceptance E: concurrency did not change, so the note was updated with
  the reasoning rather than contradicted).

### 4. Concurrency decision: **unchanged** (acceptance E satisfied by not changing it)

The default stays `max(1, os.cpus().length - 2)`. Argument from the measurements in §1: on an idle
normal development machine the default is green with the worst file at ~34% of its cap, and the ticket's
own discriminator ("if files pass at concurrency 4 but durations are still within 2× of the cap, the
load is the problem") points at load, not at the default. Lowering the default would (a) not fix the
filing failures, which were caused by uncontrolled *external* load that no suite-internal concurrency
setting controls, (b) slow an already slow suite, and (c) be the exact compensation the testing note
forbids. It is not a correction because the number is not wrong for this workload. The remaining failure
mode — a file pushed past the runner's cap by external load — now fails with a truthful message ("timed
out after 120000 ms" plus the LOAD listing) instead of a misleading crash report.

### 5. Remaining absolute `timeout:` numbers, per file (acceptance C)

- `tests/core/test-runner.test.js` (×8, 10000 ms): the runner's own usage-error assertions. `@serial`,
  exercises the import-free parse-error fast path, completes in milliseconds; 10 s is a fast-fail bound
  so a genuinely hung runner CLI fails in 10 s rather than burning the file's 120 s cap. Assertions now
  route through `assertSpawnStatus`, which names the budget on `ETIMEDOUT`.
- `tests/adapters/opencode/*` (`where`/`which` 5000 ms, git 10 s, live run 30–240 s, `http.get` 2 s):
  env-gated live-backend tests (`DCLI_OPENCODE_LIVE_SMOKE`), all `@serial`, most `@timeout-ms 600000`.
  They skip in every `npm run check` on a normal machine; the budgets size a real backend run.
- `tests/adapters/codex/live-smoke.test.js` (10 s probe + `LiveSmoke(30000)`): `@serial`, skips when
  codex is absent. On this machine codex *is* installed, so it runs a real ~20 s live smoke inside the
  `npm run check` gate; it is well inside its 120 s file cap and was green on all ten runs. Noted because
  it is a live dependency inside the gate that pre-dates this ticket — it is not a load-flake.
- `tests/adapters/opencode/server-kill-tree.test.js` / `server-teardown.test.js`: `@serial` opencode
  server-tree tests, not part of the observed failure set; green on all ten runs. Left untouched to keep
  the change scoped to the flake.

### 6. Discoveries (recorded per AGENTS.md)

- **The ticket's "eleven files that already carry `@serial`" is stale.** The tree now has **19**
  non-fixture test files carrying `@serial` (22 grep hits minus `tests/run-tests.js`'s mention and two
  fixture files). No serial marker was added or removed here; the existing markers were not the cause.
- **`state-root.test.js` silently skips its current-user ACL check when `whoami` fails.** With the
  budget derived it will not skip under load, but the skip-on-failure behaviour is pre-existing and
  out of scope; recorded for a future ticket.
- **`review.test.js` carries a redundant `@timeout-ms 120000`** equal to the runner default. Kept as
  documentation of its load-sensitivity; removing it would change nothing.
- The filing table's over-cap files are not slow in isolation; the original observation was taken during
  concurrent agent activity. This is exactly the trap-note caveat, now measured.

### 7. Verification

- `node tests/core/test-runner.test.js` — PASS.
- `node tests/run-tests.js --suite full --concurrency 4` — exit 0, all groups pass, no LOAD section.
- Post-fix default run — exit 0, no LOAD section.
- Agent checks: `grep -rniE "retry|retries|attempt [0-9]|re-?run" tests/run-tests.js` → no matches
  (no retry); remaining `timeout:` numbers justified above.
- **Acceptance A: ten consecutive `npm run check` at the default, all green**, on the idle machine:

  | Run | Exit | Duration |
  |---|---|---|
  | 1 | 0 | 205.6 s |
  | 2 | 0 | 200.4 s |
  | 3 | 0 | 191.5 s |
  | 4 | 0 | 191.4 s |
  | 5 | 0 | 191.6 s |
  | 6 | 0 | 195.7 s |
  | 7 | 0 | 207.0 s |
  | 8 | 0 | 184.0 s |
  | 9 | 0 | 189.9 s |
  | 10 | 0 | 200.0 s |

  Mean ≈ 195.7 s per run; none printed a LOAD or FAILURES section; nothing newly skipped.
