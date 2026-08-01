# Handoff — live verification and repair of the `codex` backend

**Date:** 2026-08-01
**For:** an agent working through the Codex CLI
**Read first:** [`AGENTS.md`](../AGENTS.md) — the five invariants and the nine mistakes are binding, not advisory.

---

## Why this exists

A live end-to-end pass over all three backends on 2026-07-31/08-01 found **eight real defects**. Every
one of them produced a job that *looked successful*: a clean state, an exit code of 0, or an empty diff
with no error. They are fixed and committed (`8dc544c`, `a7c7c8b`, `5e386f6`).

That pass was broad, not deep. It exercised each command once on the happy path. **This handoff is the
depth pass, scoped to the `codex` backend**, where the coverage gaps are largest — the previous pass
tested `submit`, `cancel`, and the detached-worker path on `claude` only.

Your job is to find the next layer of defects the same way: by **running the real backend and asserting
on observable artifacts**, not by reading code and reasoning about it. Every defect listed above was
invisible to the test suite, which was green throughout.

---

## Part 1 — Do not regress these (read before touching anything)

Each item below is a *fix*, with the exact reason it exists. Several of them look like unnecessary
complexity and invite "simplification". Simplifying any of them silently restores a defect that makes
a broken job report success.

| Do not | Because |
|---|---|
| Derive the state root from `--repo` (`<repo>\.dcli-state`) | `run --repo X` then `status <id>` read two different roots and reported "Job not found" for a completed job. State root is user-space; `DCLI_STATE_ROOT` is the only override. `cli/dcli.js` |
| Replace `-c sandbox_mode="<mode>"` with just `-s <mode>` in the codex adapter | Verified live on codex-cli 0.146.0: under `--ignore-user-config`, `-s` has **no effect in either direction**. `-s read-only` still wrote files — i.e. `--access read-only` was not sandboxed at all. `-s` is kept only because it agrees with the config override. `adapters/codex/adapter.js` |
| Drop `-c approvals_reviewer="auto_review"` from write access | Without it, `workspace-write` has every patch auto-rejected and the job completes cleanly having written nothing. It must **never** be passed for `read-only`. |
| Use `process.cwd()` for a child's working directory | `canonicalDir` is the engine's decision and is the isolated worktree in implement mode. `process.cwd()` made every implement job run in the invoking shell's directory, leaving the worktree untouched and `diff` empty. |
| Re-add `--no-session-persistence` to the claude adapter | Mutually exclusive with the `core.resume` capability that adapter declares. |
| Reorder `reduce()` so `process_exited` is checked before `backend_error` | A backend whose server outlives the turn exits 0 after a *failed* turn. Checking the exit first reduced a provider refusal to `done` + exit 0. A non-zero exit still wins. `core/reducer.js` |
| Use `fs.existsSync()` to decide a job is absent | It returns false for *any* stat error, including Windows' transient `EPERM`/`EBUSY`. Absence must be proven by `ENOENT`/`ENOTDIR`. An existing but unreadable record is **exit 17**, never exit 3. `core/commands/index.js` |
| Give `resume`/`diff`/`apply`/`submit` their own job-lookup `catch` | They all go through `loadJobOrThrow()` now; that is where the exit-3 rule lives, and four private copies is how they drifted. |
| Make `resumeSessionId` a backend-specific field or move it back into `adapter.Resume()` | `Resume()` runs in `onStarted`, i.e. **after** `Start()`. A backend that fixes its session at process launch has already launched. The field rides on the request so `PrepareInvocation` sees it; adapters that cannot continue a session ignore it — that is what keeps invariant #1 intact. |

Regression tests for all of the above:

```
tests/adapters/sandbox-and-workdir.test.js
tests/adapters/session-continuation.test.js
tests/core/backend-error-vs-clean-exit.test.js
tests/core/job-lookup-errors.test.js
```

If a change of yours turns one of these red, the change is wrong — not the test. If you genuinely
believe a test is wrong, stop and say so in your report with the evidence; do not edit it to pass.

---

## Part 2 — Already verified live, do not spend budget re-testing

On `codex` unless noted. All passed.

- `doctor` (incl. `--live-smoke-timeout-sec`), `capabilities`
- `run` (sync, `--json`), `read`, `status`, `list`, `tail`, `debug`
- `run --mode implement --access workspace` → `diff --stat` / `--name-only` → `apply --message`
- `--access read-only` correctly **refuses** writes (post-fix)
- `review --range`, `review --working --include-untracked`, and the `untracked_warning` when the flag is omitted
- `resume --kind fork_from_artifacts` and `--kind retry_attempt`
- `resume --kind continue_backend_session` → correctly **exit 22** on codex (`--ephemeral` means no session is persisted; the message points at the other two kinds). This is correct behaviour, not a bug.
- `submit` + `wait --all --group` fan-out across all three backends concurrently
- `cleanup --dry-run`, real deletion of an aged job, `--scrub-session-ids`, and rejection of `--older-than 0d` / `--older-than banana`
- `apply` refusing a dirty working tree (exit 2)

---

## Part 3 — The work: untested paths, in priority order

Work top-down. **Finish and commit P1 before starting P2.** For each item: run it live, record what you
observed, and only then decide whether it is a defect.

### P1 — Failure and lifecycle paths on codex (highest risk, lowest coverage)

1. **Hard timeout.** A codex job that exceeds `--hard-timeout-sec` must reach `timed_out`, **exit 24**,
   and leave no surviving process. Verify the process tree is actually dead (AGENTS.md #4: kill
   innermost-first; a parent pid is not a dependency graph). Use a prompt that genuinely runs long, and
   a short budget (e.g. `--hard-timeout-sec 30`).
2. **`cancel` on a running codex job.** Submit a long job, `cancel` it, and assert the state says
   `cancelled` **and** the backend process is gone. Exit 21 means the cancel could **not** be confirmed —
   if you see 21, that is the finding.
3. **`submit` + detached worker on codex.** The previous pass only exercised this on `claude`. Assert:
   no console window appears, the job reaches a terminal state on its own, and `worker.log` /
   the startup sentinel behave. (AGENTS.md, "No console window, ever".)
4. **Backend failure classification.** Force a real codex failure — an invalid `--model` is the cheapest —
   and assert `failure_reason` / `failure.class` are specific, not `unknown`, and that the exit code
   matches the table in `docs/2026-07-28-design-spec.md` §7.
5. **Killing the controller mid-run** (fault injection). The job must end terminal or `interrupted`,
   never stuck `running`, never orphaned.

### P2 — Option surface

6. `--effort` / `--reasoning-effort` passthrough on codex, and that `--variant` is **rejected** with a
   clear unsupported-capability error (exit 2, distinct `failure_class`).
7. Valueless flags: `--model`, `--effort`, `--message` with no value must be rejected explicitly
   (AGENTS.md #6 — all three shipped bugs here before).
8. `--access full` end to end.
9. Unknown flags and stray positionals must be rejected, not silently discarded (ADR-004).

### P3 — Review pipeline depth

10. `review --staged`, `review --path <p>` (repeatable), `--focus`.
11. **Truncation honesty.** Build a diff large enough to be truncated and assert `truncation_info` says
    so. A review that silently covers part of a change is the AGENTS.md #7 defect.
12. **Malformed findings appendix.** Make the model emit a broken appendix and assert
    `findings_status: "malformed"` — never `"ok"` with empty items, and never a crash.

### P4 — Apply and lineage

13. `apply` conflict path → **exit 25**, and the repository verified restored (never a `reset --hard`
    over changes it cannot prove it owns).
14. `apply --reset-author`, and the documented refusal of `--reset-author`/`--message` on a multi-commit
    series.
15. Resume lineage: `parent_job_id` / `root_job_id` across a chain, and resuming from a `failed` or
    `timed_out` parent.

---

## Part 4 — How to run this safely

**Every command carries both budgets.** A recipe without them is a defect (AGENTS.md #1 — an unbounded
wait once cost a user eight hours).

```powershell
# execution budget: --hard-timeout-sec   wait budget: --timeout-sec
dcli-codex run    --repo <repo> --prompt-file <f> --hard-timeout-sec 300 --json
dcli-codex submit --repo <repo> --prompt-file <f> --hard-timeout-sec 420 --json
dcli-codex wait   <job-id>      --timeout-sec 400 --json
```

Rules for this repository:

- **Never run `apply` against `D:\Documents\GitHub\dcli` itself.** Create a scratch git repo under
  `%TEMP%` for every apply/implement test, exactly as the previous pass did.
- **Isolate destructive state tests** with `$env:DCLI_STATE_ROOT = "$env:TEMP\<something>"` so a
  `cleanup` test cannot touch real job history. Unset it afterwards.
- The globally installed `dcli` is a **junction to this repo**, so your edits are live immediately and
  there is nothing to reinstall.
- Do not commit scratch directories. `.dcli-state/` in the repo root is stale leftover state from before
  the state-root fix; ignore it.

### One shell gotcha that cost the previous pass an hour

PowerShell variable names are **case-insensitive**: `$r` and `$R` are the same variable. Capturing
command output into `$r` inside a loop clobbered `$R` (the repo path), so later iterations passed
garbage to `--repo`, got a different repo key, and reported "Parent job not found" — which was *correct
behaviour* misread as a bug. Use distinct, multi-letter variable names.

---

## Part 5 — Working rules

- **TDD order**: write the failing test → verify it is red → implement → verify green → `npm run check` →
  commit. Prove the red; a test that passes before the fix proves nothing.
- **Never assert only that something threw.** Assert the failure's identity (`exitCode`, `code`,
  `failureClass`, message match) and explicitly reject `ReferenceError`/`TypeError`. Use
  `tests/helpers/assert-failure.js`.
- **A mocked-out path is an uncovered path.** Anything behind `if (this._testMode)` needs at least one
  test that does not take the short-circuit. See `tests/adapters/*/start-*-scope.test.js`.
- **`npm run check` (lint + full suite) must be green before every commit.** One commit per fix, no
  co-author trailer, docs updated in the *same* commit (`README.md`, `docs/reference/*`,
  `integration/source/*` where the behaviour is agent-visible).
- **Record verified backend facts in `docs/reference/cli-codex.md`.** The sandbox findings above are
  written up there precisely so nobody "simplifies" them back. Do the same for whatever you learn.

## When to stop and ask

Per AGENTS.md: a backend conditional appears necessary in `core/`; a documented "verified" fact turns
out false on your machine; an exit code or `status.json` field would have to change meaning; an
acceptance criterion is impossible as written. Write what you found into your report — undocumented
discoveries are how this project rots.

## What to report back

For each item in Part 3: **what you ran**, **what you observed** (exit code, state, artifact), and the
verdict — *works*, *defect (fixed in commit X)*, or *defect (not fixed, because …)*. A finding without
the command that produced it is not actionable. Do not present a passing suite as evidence that a path
works; the suite was green through all eight defects above.
