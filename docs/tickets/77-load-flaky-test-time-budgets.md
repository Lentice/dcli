# 77 — The full suite is dominated by process-creation cost, so its time budgets fail unpredictably

**What to build:** `node tests/run-tests.js --suite full` is deterministic. Today it is not: across five runs on one
machine, **five different files** failed, one run was fully green, and every failing file passes when run alone. No
failure indicates a product defect.

The cause is measured, not assumed: **creating a process on this host costs 150–230 ms**, and the suite's slowest
files spawn hundreds of them. Those files land at 40–180 s against 120–180 s budgets, so ordinary variance in spawn
cost decides which one dies. The victim rotates because it is a race against the clock, not a bug in any one test.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

## Evidence

20-core Windows host, Windows Defender real-time protection **on**. Runner defaults: concurrency `max(1, cpus-2)`
= 18, per-file timeout 120 000 ms (`tests/run-tests.js:9`).

### The suite fails somewhere different almost every run

| Run | Concurrency | Failure |
|---|---|---|
| 1 | 18 | `core/test-runner.test.js` — `file-level timeout must let the slow fixture finish` |
| 2 | 18 | *(green — 56 passed)* |
| 3 | 18 | `core/review.test.js` — timed out at 120 000 ms |
| 4 | 18 | `core/worktree.test.js` (180 000 ms) + `integration/installer.test.js` (120 000 ms) |
| 5 | 4 | `core/commands.test.js`, `core/review.test.js`, `core/worktree.test.js`, `integration/installer.test.js` (6 core failures) |

### Process creation is the dominant cost — measured

Twenty iterations each, on an otherwise-idle machine:

| Operation | Total | Each |
|---|---|---|
| `git --version` — spawn only, writes nothing | 4 595 ms | **229.8 ms** |
| `node -e 0` — spawn only | 3 015 ms | **150.8 ms** |
| `git init` — spawn + ~30 small file writes | 6 083 ms | 304.1 ms |
| Write 30 small files, no process spawned | 1 176 ms | 58.8 ms |

Spawning a process that does *nothing* costs 150–230 ms. `git init` costs only ~74 ms more than `git --version`,
so the file I/O is nearly free — the spawn is the bill. On a healthy host these are single-digit milliseconds; this
host is 10–40× that. Defender real-time protection is enabled and scans each new process image (exclusions could
not be read — that needs an elevated shell), which is the leading explanation but is **not confirmed**.

### The variance, not the mean, is what breaks the suite

`core/review.test.js` standalone, same commit, nothing else running: **49 s**, then later **147 s**, then **174 s**.
A 3.5× swing with no code change. Against a 120 s cap, the same file legitimately passes and legitimately times out
depending on when you run it.

### Two hypotheses that were tested and **rejected** — do not re-litigate them

- **Concurrency is not the cause.** Dropping to `--concurrency 4` made it *worse* (6 core failures vs 1). Lowering
  concurrency is not a fix.
- **Temp-directory crowding is not the cause.** `os.tmpdir()` holds 6 817 entries, ~820 of them leaked `dcli-*`
  fixture dirs, so this looked promising. Benchmarked directly: a second run in the crowded tmpdir (15 303 ms for
  20 `git init`) matched a freshly created empty directory (16 084 ms / 13 316 ms). The one 96 s outlier was a
  cold-cache first-touch effect, not crowding. The timeout clock also starts in `runSingle` when the file actually
  starts, not when it is queued, so queueing is not it either.

## Acceptance criteria

- [ ] `--suite full` passes **10 consecutive times** at the default concurrency with zero failures. One green run
      closes nothing — run 2 above was green while the defect was fully present.
- [ ] **Process count is reduced where it is incidental rather than essential.** This is the main lever: at ~200 ms
      per spawn, removing a thousand spawns removes ~3 minutes. Concretely: build one template fixture repo and
      *copy the directory* instead of running `git init` per case; batch sequences of `git` calls into a single
      invocation where the assertions allow; prefer reading `.git` state directly over shelling out for values the
      test already knows.
- [ ] The suite reports **each file's elapsed time next to its budget**, so margin is visible instead of inferred.
      Build this first — it is the instrument the rest of the ticket needs, and it turns the next flake into a
      reading rather than an investigation.
- [ ] **Every file within ~3× of its budget is listed in this ticket's Notes with its measurement**, whether or not
      it has failed yet. The five observed victims are a sample, not the population.
- [ ] Any budget that is raised is justified by a recorded measurement **and** a stated multiple over it, written
      into the file's header comment. A timeout with no recorded basis is what created this ticket.
- [ ] `core/test-runner.test.js` case 3 (`tests/core/test-runner.test.js:56`) no longer asserts the exact string
      `'5 passed, 2 failed'` against a 1 000 ms budget. Each fixture it runs is a real spawned `node`, and bare node
      spawn is **151 ms measured** on this host — a handful of those and an unrelated fixture times out, turning the
      tally into `4 passed, 3 failed`. It must still prove a per-file `@timeout-ms` override beats the suite default
      and is not unbounded: assert on the slow fixture's own outcome, not a global count. (This one reproduces on
      the parent commit — verified by stashing — so it predates the 2026-07-31 work.)
- [ ] Fixture temp dirs are cleaned up. ~820 leaked `dcli-*` directories are sitting in `os.tmpdir()` from past
      runs. **This is a separate defect and explicitly not the cause of the slowness** (see rejected hypotheses),
      but a suite that leaks fixtures violates the `AGENTS.md` teardown rule and should not be left.
- [ ] No fix relies on `sleep`, on permanently lowering concurrency, or on retrying a failed file. Retries hide
      exactly the class of defect this suite exists to catch.
- [ ] Lint clean and full suite green (`npm run check`).

## Development guidance

- **Attack the spawn count, not the clock.** Raising timeouts converts a 2-minute failure into a 5-minute one and
  defers the problem to the next time the suite grows. The measurements above say where the time actually goes.
- **Environment mitigation is worth documenting but must not be the only fix.** Adding Defender exclusions for the
  repo and the test temp area would likely help this host a lot, and is worth a note in the onboarding doc — but
  the suite must be sound on a machine where nobody did that, including CI. Do not close this ticket with a
  machine-configuration change.
- **Do not lower the default concurrency.** The parallel runner (ticket 28) exists because the serial suite was too
  slow to run often, and an unrun suite catches nothing. It also empirically does not help (run 5).
- Do not "fix" the `test-runner.test.js` case by widening the assertion to a regex matching any tally — that makes
  the case pass while proving nothing, which is the false-green class `AGENTS.md` already calls out.
- Check whether `getFileTimeout` / the `@timeout-ms` sentinel is the right lever before adding any new mechanism;
  the runner already supports per-file budgets, so no new knob should be needed.

## Why it matters

The full suite is the gate everything else in this project trusts — `AGENTS.md` requires it green before anything
is declared done or committed. Right now that instruction cannot be followed honestly: a green run is close to a
coin flip, so "the suite is green" has stopped carrying information. This project has already shipped a defect that
was invisible because a test was green for the wrong reason (a `ReferenceError` satisfying a bare
`assert.ok(error)`). A suite that is *sometimes red* for the wrong reason is the same failure from the other
direction, and worse in one respect: it actively teaches people to ignore red.

## How to verify

```powershell
# Must be green every time, not on average.
1..10 | ForEach-Object { node tests/run-tests.js --suite full }

# Known victims must still pass alone -- guards against a "fix" that only
# moves the cost somewhere else.
node tests/core/review.test.js
node tests/core/worktree.test.js
node tests/core/commands.test.js
node tests/core/test-runner.test.js
node tests/integration/installer.test.js
```

## Notes

- Measured 2026-07-31, 20-core Windows host, Defender real-time protection on:
  - `git --version` 229.8 ms/spawn; `node -e 0` 150.8 ms/spawn; `git init` 304.1 ms; 30 file writes 58.8 ms.
  - `core/review.test.js` standalone: 49 s, then 147 s, then 174 s — same commit, machine idle.
- Runner defaults: `DEFAULT_TIMEOUT = 120_000` (`tests/run-tests.js:9`), concurrency `max(1, cpus - 2)`.
  `core/worktree.test.js` carries a 180 000 ms per-file override and still timed out.
- `os.tmpdir()` held 6 817 entries, ~820 matching `dcli-*` (largest groups: `dcli-perm` 360, `dcli-long` 175,
  `dcli-test` 115, `dcli-nojob` 107).
- Defender exclusion list could not be read — `Get-MpPreference` requires an elevated shell. Worth checking whether
  the repo and temp paths are excluded before concluding anything about the host.
- Implemented measurement, 2026-07-31:
  - First default-concurrency full-pool run after fixture-template optimization: green in 207.8 s.
  - Files within approximately 3× of their budget: `core/test-runner.test.js` 41.5 s / 120 s.
  - `core/worktree.test.js` measured 50.2 s / 180 s in-pool and 90.1 s standalone. Its 180 s override is
    retained at 2× the measured standalone cost to cover the observed process-creation variance.
  - Previously observed victims after optimization: `core/review.test.js` 10.4 s / 120 s in-pool and
    28.3 s standalone; `core/commands.test.js` 16.6 s / 120 s; `integration/installer.test.js`
    16.6 s / 120 s. No budget increase was needed.
  - All remaining files completed below 40 s against the 120 s default and therefore were not within
    approximately 3× of their budget.
  - The first consecutive gate stopped after seven green runs when run 8 exposed a non-timeout Windows
    projection-write flake in `core/commands-tail-debug-cleanup.test.js` (0.77 s elapsed): session-id
    scrubbing used one atomic rename and silently recorded a transient rename failure. Cleanup now uses
    `JobStore`'s existing bounded atomic-write retry, and the test asserts both the persisted value and
    an empty error list.
  - After that fix, 10 consecutive default-concurrency full suites passed with zero failures:
    172.4 s, 187.2 s, 170.5 s, 170.8 s, 169.7 s, 170.5 s, 185.2 s, 169.4 s, 170.2 s, and 173.4 s.
  - Review follow-up reduced each template's setup to one `git init` process by writing the known test
    config directly, added fault injection for the transient rename retry, and fixed exact-path teardown
    for the observed `dcli-perm-*`, `dcli-long-*`, and `dcli-nojob-*` leak sites. The `dcli-test-prompt-*`
    and `dcli-test-resume-*` fixtures already had explicit `finally`/teardown cleanup.
  - Final post-review gate, on the final source state: 10/10 consecutive default-concurrency full
    suites green in 182.3 s, 168.8 s, 168.1 s, 167.8 s, 168.0 s, 173.1 s, 180.3 s, 183.1 s, 182.0 s,
    and 177.6 s.

## Commit message

```
fix(tests): cut process-spawn count and set measured time budgets so the suite is deterministic
```
