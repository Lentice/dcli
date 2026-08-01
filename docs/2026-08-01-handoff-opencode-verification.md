# Handoff — live verification and repair of the `opencode` backend

**Date:** 2026-08-01
**For:** an agent working through the OpenCode CLI
**Scope:** test the real `opencode` backend deeply, fix defects found, and preserve all existing Codex/Claude fixes.

Read `AGENTS.md` and `docs/tickets/00-onboarding.md` first. The five invariants and the nine mistakes in
`AGENTS.md` are binding. This is a continuation of the Codex verification pass, not a clean-slate rewrite.

## Current baseline — do not regress

The repository is currently at commit `3cc4d28` (`fix(integration): bound outer dcli invocations`), ahead of
the earlier live-verification fixes `8dc544c`, `a7c7c8b`, and `5e386f6`.

The following behavior is already fixed and must remain intact:

- State root is user-space; do not derive it from `--repo`.
- Codex sandbox access uses the authoritative config override and write access includes its approval reviewer.
- Implement jobs use the engine-selected isolated worktree, not the caller's `cwd`.
- Reducer ordering preserves backend failures when a backend exits cleanly after a failed turn.
- Missing-job detection distinguishes `ENOENT` from unreadable/corrupt state.
- All read-side commands use the shared job loader.
- `resumeSessionId` is request data visible before adapter start, not a backend-specific core branch.
- Integration recipes, rules, commands, and worker prompts require bounded execution, bounded waits, and a finite
  outer shell/tool timeout. Generated artifacts must remain in sync with `integration/source/`.

Do not simplify or revert these changes. Do not add backend-specific conditionals to `core/`. Do not change the
meaning of an existing exit code or `status.json` field. Do not hand-edit generated integration files.

## Objective

Run the real OpenCode backend and assert observable artifacts: exit code, byte-exact stdout, terminal `status.json`,
backend event logs, result/findings files, worktree/diff state, and process/window cleanup. The existing test suite is
not sufficient evidence by itself; every live scenario below must be run against the actual backend.

For each scenario record:

1. The exact command and both budgets.
2. Observed exit code and terminal state.
3. Relevant artifact paths and process identity/cleanup evidence.
4. Verdict: `works`, or `defect (fixed in commit X)`, or `defect (not fixed, because ...)`.

If a verified fact in the existing OpenCode reference is false on this machine, stop, record it in this file's
Notes section, and report it rather than silently changing the contract.

## P1 — lifecycle and failure paths

Finish and commit P1 before starting P2. Use isolated state roots under `%TEMP%` for destructive lifecycle tests.
Never run `apply` against `D:\Documents\GitHub\dcli` itself; use a disposable scratch git repository.

### 1. Hard timeout

Run a prompt that genuinely remains active beyond a short budget, for example:

```powershell
# execution budget: --hard-timeout-sec 30; outer command budget: >45s
dcli-opencode run --repo <repo> --prompt-file <long-prompt> --hard-timeout-sec 30 --json
```

Expected result: wrapper exit `24`, state `timed_out`, `failure_reason=hard_timeout`, and no surviving server,
worker, launcher, or detached descendant. Verify the process tree by identity, not by image-name hunting. For the
OpenCode server path also verify the reserved port is no longer held.

### 2. Cancel a running job

Submit the same kind of long prompt, then cancel it immediately:

```powershell
# submit execution budget: 120s; each wait budget: 60s; outer budgets finite
dcli-opencode submit --repo <repo> --prompt-file <long-prompt> --hard-timeout-sec 120 --json
dcli-opencode cancel <job-id> --repo <repo> --json
dcli-opencode wait <job-id> --repo <repo> --timeout-sec 60 --json
```

Expected result: state `cancelled`, cancellation confirmed (not exit `21`), backend server disposed or killed,
and no process/port leak. Do not treat a cancel request or phase change as confirmation; read terminal state.

### 3. Detached worker and startup sentinel

Run `submit` with a short, deterministic prompt and collect with bounded `wait`. Verify `worker-started.json` (or
the current sentinel artifact), `worker.log`, terminal state, and backend event persistence. On Windows verify no
descendant owns a visible top-level console window. `conhost.exe` presence alone is not a failure signal.

### 4. Backend failure classification

Force a real OpenCode failure using the cheapest deterministic mechanism available on this installation (invalid
model/provider or an intentionally unreachable provider). Assert the specific `failure_reason`/`failure.class`
and the exit code from `docs/2026-07-28-design-spec.md` §7. A clean exit, empty result, or `unknown` classification
is a defect. Do not retry auth, quota, permission, network, or timeout failures automatically.

### 5. Controller crash / reconciliation

Kill the controlling wrapper at each relevant startup or running checkpoint using the existing fault-injection
style. The job must reconcile to terminal or `interrupted`, never remain `running` forever, and never leave an
unowned OpenCode server or worker. Preserve `failure_reason` and `backend_session_id` during reconciliation.

## P2 — option and permission surface

Test the OpenCode-specific `--variant` passthrough and reject unsupported Codex-only options. Verify:

- `--variant` reaches the OpenCode invocation and affects the recorded command/configuration as documented.
- `--effort` and `--reasoning-effort` are rejected with a clear unsupported-capability usage error where applicable.
- Valueless `--model`, `--variant`, and `--message` are explicit validation errors (exit `2`), not silently accepted.
- `--access read-only`, `workspace`, and `full` behave end to end; permission requests do not become unbounded waits.
- Unknown flags and stray positionals are rejected rather than discarded.

## P3 — review pipeline depth

Run live OpenCode reviews for `--staged`, `--path` (repeatable), `--focus`, and `--include-untracked`. Then verify:

- A deliberately oversized diff reports truncation in `truncation_info`; coverage is never silently reduced.
- A malformed findings appendix yields `findings_status: malformed`, never a clean empty review or parser crash.
- Missing/untracked coverage is reported explicitly.
- Raw backend events stay in `backend-events.jsonl` and never reach parent stdout.

## P4 — apply and lineage

Use a disposable scratch repository and isolated worktree for all apply tests.

- Apply conflict returns exit `25` and verifies the main repository was restored without discarding unexpected user
  changes.
- `--reset-author` and `--message` follow the documented single-commit/multi-commit restrictions.
- `parent_job_id` and `root_job_id` remain correct through fork/retry/resume chains, including failed and timed-out
  parents.
- `diff` refuses to offer a partial artifact when snapshot finalization failed.

## Required implementation discipline

For every defect:

1. Add a failing regression test first and prove it is red.
2. Implement the smallest fix in the correct adapter/core boundary.
3. Run the focused test, then `npm run check` (lint plus full suite).
4. Update `docs/reference/cli-opencode.md` with any newly verified backend fact.
5. Update `integration/source/*` and regenerate `integration/generated/*` if an agent-visible command, flag, or
   behavior changes. Re-run the installer and verify installed copies byte-match the repository.
6. Commit one ticket-sized change. Do not include scratch repositories, temporary prompts, or agent state.

Never auto-apply a delegated worktree. Inspect `diff --stat` and `diff` first, and get explicit human approval for
`apply`. Never present raw delegated output as your own conclusion.

## Notes

Record machine/version facts, commands, observations, rejected findings, and any contradiction with the existing
contracts here as the work progresses. Do not leave live verification discoveries only in chat.

