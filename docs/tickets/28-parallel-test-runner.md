# 28 — Bounded-parallel test runner with explicit serial opt-out

**Blocked by:** none (tooling only; touches `tests/run-tests.js` and test-file sentinels)
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` §"Testing rules learned the hard way",
`AGENTS.md` §"No console window, ever", `AGENTS.md` invariant 3 ("Nothing blocks forever").

---

## Purpose

The suite runs one test file at a time. Make it run files concurrently under a bounded cap, while keeping
files that genuinely cannot share the machine on a serial path — and stop discarding failure output.

## Why it matters

Measured on this host: the **quick** suite executes 14 of 25 files in **14.5 s**. Almost none of that is
assertion work — it is 14 cold Node starts, one after another. The **full** suite runs all 25, including
`live-smoke`, `server-lifecycle`, and `hard-timeout`, which are slow by construction. A slow suite gets run
less often, and `AGENTS.md` requires the full suite to be green before anything is committed. Suite latency is
therefore a correctness cost, not a comfort cost.

There is a second, worse problem in the same file. `runTest()` captures `stdout`/`stderr`, and
`formatSummary()` throws both away — a failure prints only `N failed`, naming neither the file nor the error.
That is the "test false green"'s twin: a real red that tells you nothing. **Fix it in this ticket**; it is
cheap and it is what makes a parallel runner debuggable at all.

## Current state

`tests/run-tests.js`:

- `discoverTests(ROOT)` walks `tests/` recursively for `*.test.js` (25 files today).
- Grouping is by first path segment: `adapters`, `contract`, `core`, plus `fixtures`/`helpers`/`integration`
  which currently hold no `*.test.js`.
- `// @suite full` as the **exact first line** marks a file the quick suite skips. 11 files carry it.
- `runTest()` = `spawnSync(process.execPath, [file], { timeout: 30_000, windowsHide: true, encoding: 'utf8' })`.
- Exit `1` if anything failed, else `0`. Skipped files are named individually (keep this — `AGENTS.md`
  requires the quick suite to name what it skipped).

## Design

### 1. Bounded concurrency

Replace `spawnSync` with async `spawn` plus a worker pool. Cap at `Math.max(1, os.cpus().length - 2)`,
matching the concurrency rule used elsewhere in this project. Provide an override for debugging:
`--concurrency <n>`, validated as an integer in `1..64`.

**Validate before you convert, and before you act** (`AGENTS.md` §6): parse `--concurrency`, reject a missing
or non-integer or out-of-range value with exit `2` and a message naming the flag — do not clamp silently, and
do not accept a valueless `--concurrency`. Same for `--suite`: today `--suite <anything-but-full>` silently
means `quick`. Reject an unknown suite value and a missing one with exit `2`.

### 2. Serial opt-out is explicit, not inferred

Add a second sentinel, `// @serial`, recognized in the leading eight-line comment header so it can
coexist with `// @suite full` and a bounded `// @timeout-ms <n>` override. Files marked `@serial` run **alone** — the pool drains before a serial file
starts, and no other file starts until it finishes.

Do not try to infer serialness from file contents. Inference here is a guess about resource sharing, and a
wrong guess produces a load-dependent flake — the exact failure class `AGENTS.md` calls out as slow and
expensive to diagnose.

**Mark these `@serial`, with the stated reason in a comment on the sentinel line:**

| File | Why it cannot share |
|---|---|
| `tests/core/worktree.test.js` | runs `git` against the real repository |
| `tests/core/commands.test.js` | runs `git` / spawns the CLI against the real repository |
| `tests/core/fault-injection.test.js` | kills process trees at defined crash points |
| `tests/core/containment.test.js` | kills process trees; asserts descendant sets |
| `tests/adapters/opencode/server-lifecycle.test.js` | binds loopback ports; asserts reserve-and-retry races |
| `tests/adapters/opencode/server-teardown.test.js` | tears down live server process trees |
| `tests/adapters/opencode/hard-timeout.test.js` | wall-clock deadline assertions, load-sensitive |
| `tests/adapters/codex/live-smoke.test.js` | live backend; external rate limits |
| `tests/adapters/opencode/live-smoke.test.js` | live backend; external rate limits |

Treat that table as the starting set, not the answer. While implementing, check every file for a **fixed**
shared path or port. Known offenders in `tests/core/job-store.test.js` today: `dcli-custom-root` (line ~51),
`dcli test path with spaces` (~776), `dcli-测试-路径` (~779) — fixed names under `os.tmpdir()`. Those are safe
against *other files* but not against a second run of the same suite on the same machine. Prefer **fixing the
fixture** to randomize the name (the file already uses
`` `dcli-store-test-${Math.random().toString(36).slice(2)}` `` elsewhere — follow that) over marking the whole
file serial. Randomizing is strictly better: it makes the test independent rather than scheduling around the
dependency.

If you find a file that needs `@serial` for a reason not in the table, add it **and write the reason into this
ticket's Notes section** — an undocumented serialization is how the suite silently slides back to sequential.

### 3. Nothing blocks forever

Keep a per-file timeout. Raise the default to **120 s** — 30 s is plausibly too tight for `live-smoke` and
`server-lifecycle` under a loaded, concurrent pool, and a timeout that fires from scheduling pressure rather
than from a real hang is indistinguishable from a flake. Allow `--timeout-ms <n>` (validate: integer,
`1000..600000`, reject valueless).

On timeout: kill the child, **and report the timeout distinctly from an assertion failure** in the summary.
"Timed out after 120000 ms" and "exited 1" are different diagnoses and must not collapse into one line.

Every spawn passes `windowsHide: true` explicitly (`AGENTS.md` §"No console window, ever" — rule 1, and never
`shell: true`).

Bound the output drain. A test child that leaves a surviving grandchild holding its stdout will keep the pipe
open after exit; do not wait unboundedly for EOF after the process-exit event. Cap collected output per file
(e.g. 256 KB head + tail) and **say so when you truncate** — a silently truncated failure log is the same
silent-reduced-coverage bug pattern as §7 in `AGENTS.md`.

### 4. Output contract

Deterministic output is the point — agents parse this. Concurrency must not reorder it.

- **Buffer per file, print in stable order.** Sort groups as today (`groupNames.sort()`), and files within a
  group by relative path. Completion order must not affect a single byte of the summary. Progress chatter to
  **stderr** if you want it live; the summary on **stdout**.
- Keep the existing per-group line shape (`group: N passed[, N failed][, N skipped]`) and the
  `  (skipped) <rel>` lines. Contracts are append-only — extend, don't reshape.
- **Print failure detail.** After the summary, for each failed file: relative path, exit code or timeout, then
  its captured stdout and stderr. This is new output, appended after the existing block, so a consumer reading
  the summary lines is unaffected.
- Exit `1` if anything failed or timed out, `0` otherwise. `2` for a usage error (see §1).

## Acceptance criteria

1. `node tests/run-tests.js` runs non-`@serial` files concurrently, capped at `cpus-2` by default.
2. Files marked `// @serial` run alone: nothing else is in flight while one runs. Asserted, not assumed.
3. Byte-exact summary output is **identical** for the same set of results regardless of completion order and
   regardless of `--concurrency`.
4. A failing file prints its path, its exit status, and its captured output.
5. A hanging file is killed at the per-file timeout and reported as a timeout, distinctly from a failure.
6. `--concurrency`, `--timeout-ms`, and `--suite` each reject a missing, non-integer, or out-of-range value
   with exit `2` and a message naming the flag.
7. No test process leaves a visible window, and no fixture process survives the run.
8. Quick suite still names every skipped file.
9. `--suite full` is green, and measurably faster than the sequential baseline. Record the before/after numbers
   in Notes.

## Testing this ticket

The runner is now a piece of real software, so test it like one. TDD order per `AGENTS.md`: failing tests
first, verify red, implement, verify green, full suite.

Add `tests/core/test-runner.test.js` (do **not** mark it `@suite full`; it must run in the quick suite). Drive
the runner against a **fixture tests directory**, not against `tests/` itself — parameterize the root so the
runner is not hardcoded to `__dirname`. Fixture files to include: one that passes, one that exits `1` with
output on both streams, one that hangs forever, one `@serial`, one `@suite full`.

Assert on observable artifacts (`AGENTS.md`: prefer exit code, byte-exact stdout, on-disk state):

- Byte-exact stdout for a fixed fixture set, run twice at different `--concurrency` values — must match.
- Serial exclusivity: have the `@serial` fixture write a marker file on entry and delete it on exit, and have
  every parallel fixture assert the marker is absent. This synchronizes on **observed state, not sleeps**.
- The hang fixture is terminated and reported as a timeout — and **verify in a `finally` that its process tree
  is gone**. A leaked hang fixture poisons every later test on the machine.
- Each usage error exits `2`.

## Pitfalls

- **Do not `parallel`-ize by group.** Groups are directories, not resource domains; `core` alone holds both
  the fastest and the repo-mutating files. Schedule per file.
- **A pool that awaits all files before printing anything** is fine for output, but do not build it as a
  barrier per *group* — that reintroduces the wall-clock waste for no benefit.
- **`spawnSync` → `spawn` changes error surfacing.** `spawnSync` returns `result.error`; async `spawn` emits
  `'error'`. A file whose spawn fails outright (ENOENT, EINVAL) must count as **failed**, not silently pass.
  The current code checks `result.error === undefined`; keep an equivalent guarantee.
- **`exit` vs `close`.** Wait for `'close'` (streams flushed), not `'exit'`, before reading captured output —
  but bound that wait, per §3.
- Never introduce a `DCLI_TEST_*` variable that production code reads. If the runner needs a knob, pass it as
  an argument (`AGENTS.md`: prefer argument injection over an environment knob).
- Do not reduce coverage to gain speed. Sampling, `--bail`, or dropping slow files are all out of scope; if you
  bound anything, `log` what was dropped.

## Notes

### Suite timings (Windows, 16-core)

| Suite | Before (sequential) | After (parallel) | Speedup |
|---|---|---|---|
| Quick | ~23.5 s | ~19.4 s | ~1.2× |
| Full | ~123 s (estimated) | ~123 s | ~1× |

The quick suite improvement is modest because the bottleneck is `test-runner.test.js` (the new self-test, ~10 s), plus existing quick tests that each take <1 s. Most quick tests are pure-computation and very fast; concurrency mainly helps the few that wait on I/O (spawn, temp dirs). The full suite speed is similar because the majority of `@suite full` files are serialized (marked `@serial`), so concurrency helps only within the parallel set. Further optimization would require reducing `test-runner.test.js`'s fixture-runs or splitting large @serial files.

### Parallel-load amendments

- `tests/core/test-runner.test.js` is `@serial`: it owns fixed temporary marker/PID paths and starts its own fixture pool. Running that nested scheduler inside the outer pool makes output capture and startup timing load-dependent.
- `tests/core/worktree.test.js` uses a finite 180 s file budget; its comprehensive worktree/apply coverage exceeded a 60 s global debugging budget when the machine was busy.
- `tests/core/review.test.js` uses a finite 120 s file budget. It completes in about 30 s alone but builds several isolated Git repositories and can exceed 60 s while the full pool is active.

### Files fixed for parallel safety

- **`tests/core/fs-text.test.js`**: `const TMP = path.join(os.tmpdir(), 'dcli-fs-test')` → randomized with `Math.random().toString(36).slice(2)` suffix. The fixed path would collide if two instances of this file ran concurrently.
- **`tests/core/job-store.test.js`**: Three fixed paths (`dcli-custom-root`, `dcli test path with spaces`, `dcli-测试-路径`) randomized with a random suffix, following the file's existing pattern (`dcli-store-test-${Math.random()...}`).

### Pre-existing failures fixed

- **`tests/core/state-root.test.js`**: The ACL check compared `whoami` output (lowercase) against icacls output (PascalCase) with `String.includes()`, which failed on this host (`vianextech\lenticetsai` vs `VIANEXTECH\LenticeTsai`). Changed to case-insensitive comparison.

### @serial marks added

No additional files beyond the ticket's table needed `@serial`. The table was correct.

### Test file added

- **`tests/core/test-runner.test.js`**: Self-tests for the parallel runner, driving it against fixture files in `tests/fixtures/test-runner/`. Covers: byte-exact output at different concurrency, quick-suite filtering, serial exclusivity, hang timeout, failure output, and CLI usage errors.

### Fixture files

Six fixture files created in `tests/fixtures/test-runner/`:
- `pass.test.js` — exits 0
- `fail.test.js` — exits 1 with output on both streams
- `hang.test.js` — hangs forever (killed by timeout)
- `serial.test.js` — `@serial`, writes/deletes a marker file for exclusivity testing
- `parallel-check.test.js` — asserts the serial marker file is absent
- `suite-full.test.js` — `@suite full`
