---
name: dcli-opencode
description: Delegate bounded work to the opencode CLI as a different backend, including interactive-capable runs. Use when wrapper job guarantees are needed.
---

<!-- dcli:opencode skill -->

# Core delegation patterns (shared by all backends)

## Native subagents come before dcli

`dcli` is the cross-backend boundary. It is not the generic command for spawning a
subagent. When the current agent needs a worker from its own backend, use that
backend's native subagent capability directly:

- Codex uses Codex's native subagent tool; same-backend work is not `dcli-codex`.
- Claude Code uses its native Task/subagent capability; same-backend work is not `dcli-claude`.
- opencode uses its native task/agent capability; same-backend work is not `dcli-opencode`.

Use dcli only when the task intentionally crosses to another backend. Its
durable job record, detached execution, wrapper findings contract, and isolated
worktree are guarantees for that cross-backend boundary; they do not replace a
same-backend native subagent.

**A third-party plugin that calls a backend is not dcli.** Some plugins ship a
subagent that forwards to their own runtime — a Codex-flavoured rescue subagent
is the observed case. It looks like the native path to that backend and is not:
it has its own job store, so `dcli status <its id>` cannot find the job,
`dcli list` never shows it, and nothing dcli offers (durable state, bounded
wait, cancellation, resume lineage) applies. A forwarder-shaped subagent that
returns only a job id and cannot poll it is not a delegation you can audit.
When you cross a backend boundary deliberately, invoke this skill's own shim.

## Canonical recipe — send and wait for the report

The shortest correct cross-backend delegation is one synchronous `run` carrying
both budgets, with the outer tool's own timeout set longer than the hard budget:

```
<shim> run --repo <repo> --prompt-file <file> \
  --hard-timeout-sec 900 --timeout-sec 900 --label <label>
```

(`<shim>` is this skill's shim command, shown in the examples below.)

Reach for `submit` + `wait` only when the outer runner cannot set a timeout at
all, or when the work should not hold the caller open.

## Skill slash command -> CLI subcommand

The slash-command names are not CLI subcommands — `jobs` is not a command:

| Slash command | CLI subcommand |
|---|---|
| `:jobs` | `list` |
| `:ask` | `run` (or `submit`) |
| `:implement` | `run --mode implement` |
| `:review` | `review` |
| `:resume` | `resume` |
| `:doctor` | `doctor` |
| `:cleanup` | `cleanup` |

A mistyped subcommand is rejected with a suggestion (`Unknown command: jobs —
did you mean 'list'?`), not with usage text.

## Doctor

`<shim> doctor --json` runs the common checks and, by default, starts the selected
backend and sends a trivial read-only request. The live smoke is bounded to 120
seconds by default; `--live-smoke-timeout-sec <n>` overrides that deadline.
Inspect `ok`, `coverage`, and `live_smoke_timeout_sec` in the envelope. A live
smoke failure is non-ok and carries its failure class. Use
`--live-smoke-timeout-sec 0` only when a static-only check is intentional; the
response reports `coverage: static_only` and a skipped `live_smoke` probe.

## Job IDs

A dcli job id is `<UTC compact timestamp>-<8 alphanumerics>`, e.g.
`20260804T123456Z-a1b2c3d4`. An id in any other shape is rejected as a usage
error (exit 2, `Not a dcli job ID`) before any lookup — it belongs to another
runtime and no dcli command can act on it. `list` shows the ids that exist.

Job records are namespaced per repository. Pass the same `--repo` you submitted
with, or run from that repository; a correct id read from the wrong repository
reports exit 3.

## When to delegate

Delegate only bounded, worthwhile work:
- A genuinely independent second opinion on a design or implementation
- A scoped code review whose diff never enters your own context window
- A long-running task submitted to the background
- A code change in an isolated worktree you inspect before applying

**Always pass an execution budget and a wait budget.** Every recipe must carry:
- `--hard-timeout-sec <n>` — the maximum wall-clock time the backend may spend
- `--timeout-sec <n>` — how long `wait` blocks for completion before returning

Without both, a stalled job can silently consume an entire working session.

When `--timeout-sec` is omitted, the CLI uses a 300-second caller-side wait budget. This is a safe
fallback, not the job's execution deadline: exit 20 means only that the caller stopped waiting while
the job may still be active. JSON wait results include `wait_timed_out` and `wait_timeout_sec` so an
agent can make that distinction without parsing human text. Documented recipes still pass an explicit
wait budget so the task's intended bound is visible.

There is a third boundary when an agent invokes dcli through a shell or tool:
the outer command runner must also have a finite timeout longer than the dcli
hard budget (allowing startup and cleanup slack). If the outer runner cannot
set that timeout, use `submit` and return immediately; collect later with
`wait --timeout-sec <n>`. Never leave either the outer invocation or a dcli
`wait` unbounded.

## Preferred patterns

- **Submit long tasks to the background** with `submit`. Use `wait --all --group <group>` to gather results, never a hand-rolled poll loop.
- **Prefer `submit` for work that may approach the caller's timeout.** A synchronous `run` is bounded by `--hard-timeout-sec`, but the calling shell/tool still needs its own finite timeout; `submit` avoids holding that outer call open.
- **Inspect before applying.** For implement-mode jobs, always run `diff <job-id> --stat` then `diff <job-id>` before `apply`. Never auto-apply.
- **There is no policy engine.** `dcli` has no `.dcli/policy.json`, no auto/ask/off modes, and no checkpoint that can apply on your behalf. `apply` is always an explicit human-approved step. If you have read otherwise anywhere, it does not describe this tool.
- **Independently verify every finding.** Never present a delegated review's raw output as your own conclusion. Triage each finding: adopt with action, or reject with a stated reason.
- **Use exact wrapper lineage.** Use `resume <job-id> --kind continue_backend_session` for follow-ups. Never "continue last session" — it is ambiguous and can attach to the wrong conversation.
- **React per the failure-class table.** Never retry quota, auth, permission, or timeout failures. A `findings_status: malformed` report is not a clean review — it means the output was unparseable.
- **Keep review intent neutral.** Intent is context, not evidence of correctness.
- **Keep delegated work out of your context until collection.** When token saving is the point, use `submit` + later `read` rather than `run`.

## Never treat progress as completion

A job holding a finished result while its process tree is still alive is a real,
observed condition — not a theoretical one. So:

- **Decide from the terminal state**, read via `status` or the value `wait`
  returns. A phase, a log line, a progress message, or "the backend said it was
  done" is not a completion signal.
- **When `wait` returns, check why.** Exit 20 means the wait budget elapsed, not
  that the job failed — the job is still running and you may wait again. Do not
  read exit 20 as a result.
- **`interrupted` means the worker died, not that the backend answered.** A job
  whose worker is provably gone is resolved to `interrupted` the next time
  anything reads it, so a crashed or killed run ends rather than sitting in
  `running`. There may be no result; check before reading one.
- **A documented wait should carry an explicit `--timeout-sec`**, even though the CLI has a 300-second
  fallback for ad-hoc calls. A wait returning exit 20 means the caller budget elapsed; check the job
  state and wait again rather than treating it as a job failure.
  An unbounded wait once consumed an entire working session while the backend's
  result had been sitting complete for minutes.

## A budget bounds the wrapper, not the backend

`--hard-timeout-sec` and `--timeout-sec` bound what **dcli** does — they end the
attempt, write the record, and return control to you. dcli does not currently
contain the backend's process tree, so a backend that ignores cancellation, or a
tool the backend spawned, can outlive the job that started it.

The record states this rather than claiming otherwise:

- A hard timeout writes `kill_skipped: "not_contained"` on the `timed_out` detail.
- A cancel whose declared rungs all fail records
  `cancel_rung_reached: "containment_unavailable"` — never the rung name `hard_kill`.

So: exit 24 and exit 21 mean the wrapper stopped waiting and recorded honestly,
not that a process was killed. If a survivor would be a problem — it holds a lock,
a port, or a worktree — check for one before re-running the job.

## Cancelling and cleaning up

- **Preview before deleting.** Run `cleanup --dry-run` first and read what it
  lists. Retention once removed a worktree mid-operation and destroyed the only
  artifact needed to retry the work.
- Cleanup removes eligible terminal job records together with their isolated
  worktree directories and git registrations. It also discovers orphan
  worktree directories under dcli's state root. The preview names every
  worktree and reports its bytes; artifacts held by `diff`/`apply` are named
  and skipped under the repository lock and job lease.
- **A cancel is not confirmed until the state says so.** Exit 21 means
  cancellation could not be confirmed — check `status` rather than assuming the
  job is dead.
- **A foreground `run`/`resume` responds to `dcli cancel` exactly like a
  backgrounded `submit` job.** The running attempt watches the same
  `cancel.request` file the worker watches, reaches `cancelled`, and exits 0.
  Do not treat a foreground run as uncancellable and wait out its hard budget.
- **Never clean up a job whose diff you have not yet inspected or applied.** The
  worktree is the artifact; once it is gone the work cannot be recovered.

## An advisory review does not block your task

A delegated review is advice, not a gate. If it returns late, returns
`malformed`, or fails outright, say so and continue with your own work — do not
stall the engineer's task waiting on a second opinion, and do not silently
adopt an unverified finding to close the loop.

## Failure-class reference

| Exit | Class | Reaction |
|------|-------|----------|
| 2 | Usage/validation error | Fix the invocation. No job was created. Includes an id that is not a dcli job id at all. |
| 3 | Job not found | Well-formed id, no such job here. Check the id and that `--repo` matches the submitting repository. |
| 4 | Job not terminal | Wait longer or check status. |
| 10 | Backend execution failed | Read `failure_reason` for details. |
| 11 | No usable result | Preserve events; resume or retry. |
| 12 | Environment/compatibility failure | Run `doctor` for diagnostics. |
| 13 | Authentication failure | Run `<backend> login` / `auth`. Never retry automatically. |
| 14 | Quota or rate-limit | Note it; continue without the work. Never retry. |
| 15 | Permission/access denied | Refine the permission profile. Never retry automatically. |
| 16 | Network failure | At most one jittered retry for read-only jobs only. |
| 20 | Caller wait budget elapsed | Job may still be active; check the returned state, increase `--timeout-sec`, or check later. |
| 21 | Cancellation unconfirmed | Check job status manually. |
| 22 | Session expired | Start a fresh job with `fork_from_artifacts` or `retry_attempt`. |
| 23 | Repo/worktree preparation failure | Check repo health, run `doctor`. |
| 24 | Hard timeout | The execution budget elapsed and the attempt was ended. The backend's process tree is **not** guaranteed to be dead — see "A budget bounds the wrapper, not the backend" below. Increase `--hard-timeout-sec` if the task legitimately needs more time. Never retry unchanged. |
| 25 | Apply conflict | Main repo verified restored. Resolve and retry. |
| 26 | Protocol incompatible | Requires a compatibility update. Run `doctor`. |

## Findings contract

A review result carries a machine-readable findings appendix. The marker sits on
its own line, **before** the fence — a marker inside the fence does not parse:

<!-- dcli:findings -->
```json
{
  "verdict": "One-line verdict.",
  "items": [
    { "severity": "important",
      "file": "relative/path.ts",
      "line": 42,
      "claim": "One-sentence defect claim.",
      "evidence": "Why this is real and reachable." }
  ]
}
```

Fields:

- `verdict` — required, non-empty, one line.
- `items` — required, always an array.
- `severity` — required per item, one of `critical`, `important`, `minor`.
- `claim` — required per item, non-empty.
- `file` — repository-relative, or null. Absolute paths (including `C:\...`,
  `D:/...` and `\\server\share\...`) and `..` traversal are rejected.
- `line`, `evidence`, `suggested_fix` — optional, may be null.

The appendix must be the last thing in the output, and must appear exactly once.

Reading the status:

- `findings_status: ok` — the appendix parsed. An **empty `items` array is a clean
  review**, and it is the only way a reviewer can report "I found nothing".
- `findings_status: absent` — no appendix at all. This does **not** mean clean; it
  means the reviewer did not produce the required structured output, so you do not
  know what it concluded.
- `findings_status: malformed` — an appendix was found but could not be parsed.
  Also **not** a clean review. Truncated JSON and duplicate markers land here.

For `absent` and `malformed`, read the prose in `result.md` — it is always
preserved — and treat the structured verdict as missing rather than empty.


# dcli-opencode skill

Backend: opencode (opencode serve per job over HTTP)

## Capabilities

| Capability | Supported |
|---|---|
| Interactive permissions | Yes — can answer permissions and questions mid-run |
| Graceful cancel | Yes — session abort, server dispose, then hard kill |
| Structured output | Broken — use wrapper-side findings extraction |
| Effort/reasoning | `--variant <string>` (unbounded, provider-specific) |

## Flags specific to this backend

- `--variant <string>` — provider-specific reasoning variant (use instead of `--reasoning-effort`)

## Commands

### review

Scoped code review. The wrapper generates the diff and embeds it in the prompt.

```
dcli-opencode review [--working|--staged|--range <base>..<head>] [--path <p>] [--intent <s>] [--focus <s>] [--embed-diff] [--include-untracked] --hard-timeout-sec <n>
```

- `--access` is always `read-only` for review
- `--embed-diff` is the default
- Intent is context, not evidence — keep it neutral

### ask / brainstorm

Open-ended question or design discussion.

```
echo "Question or prompt" | dcli-opencode run --hard-timeout-sec <n>
```

`run` has an execution budget, but the shell or agent tool invoking it must
also have a finite outer timeout longer than `<n>` plus startup/cleanup slack.
If that outer timeout cannot be set reliably, use `submit` and collect the
result with `wait --timeout-sec <n>` instead.

### implement

Isolated implementation in a detached git worktree. Inspect `diff` before `apply`.

```
echo "Description of change" | dcli-opencode run --mode implement --access workspace --hard-timeout-sec <n>
dcli-opencode diff <job-id> --stat
dcli-opencode diff <job-id>
dcli-opencode apply [--reset-author] [--message <s>] <job-id>
```

### resume

Continue a completed job with one of three explicit strategies:

```
echo "Follow-up prompt" | dcli-opencode resume <job-id> --kind continue_backend_session --hard-timeout-sec <n>
```

- `continue_backend_session` — continues the same backend conversation
- `fork_from_artifacts` — new session seeded from parent's artifacts
- `retry_attempt` — re-runs the same request as a new attempt

### jobs (status / list / wait)

```
dcli-opencode status <job-id> [--json]
dcli-opencode list [--group <g>] [--json]
dcli-opencode wait <job-id> --timeout-sec <n> [--json]
dcli-opencode wait --all --group <g> --timeout-sec <n> [--json]
```

### doctor

```
dcli-opencode doctor [--json]
```

The command runs a bounded live smoke by default. Add
`--live-smoke-timeout-sec <n>` to override the deadline, or use
`--live-smoke-timeout-sec 0` for an explicitly reported static-only check.

### cleanup

```
dcli-opencode cleanup [--older-than <Nd|Nh>] [--dry-run] [--scrub-session-ids]
```

`N` must be a positive integer; `d` means days and `h` means hours.

Removes aged terminal job records and their isolated worktrees/git
registrations, and removes orphan worktrees under the dcli state root. Use
`--dry-run` first: it names each worktree and reports its bytes. Worktrees
held by a reader or repository operation are named and skipped.

## Recipes

### Get a second opinion on a design (synchronous, with budgets)

```powershell
$budget = 900
"Compare these two designs for maintainability and performance." |
  dcli-opencode run --hard-timeout-sec $budget
```

### Review a specific path since main

```powershell
$budget = 900
dcli-opencode review --range main..HEAD --path src/api/ --intent "Review the new API endpoint" --hard-timeout-sec $budget
```

### Background a long task and gather later

```powershell
$budget = 3600
"Run the full test suite and report failures." |
  dcli-opencode submit --access workspace --group nightly --hard-timeout-sec $budget
dcli-opencode wait --all --group nightly --timeout-sec 3600 --json
```

### Background implementation

`submit --mode implement` honours implement mode: a worktree is prepared at
submit time, the detached worker runs inside it, and `diff`/`apply` work on
the job exactly as for `run --mode implement`.

```powershell
$budget = 1800
echo "Add input validation to the user registration form" |
  dcli-opencode submit --mode implement --access workspace --group nightly --hard-timeout-sec $budget
dcli-opencode wait --all --group nightly --timeout-sec $budget --json
dcli-opencode diff <job-id> --stat
dcli-opencode diff <job-id>
dcli-opencode apply --reset-author --message "feat: add input validation" <job-id>
```

### Implement a change, inspect, then apply

```powershell
$budget = 1800
echo "Add input validation to the user registration form" |
  dcli-opencode run --mode implement --access workspace --hard-timeout-sec $budget
dcli-opencode diff <job-id> --stat
dcli-opencode diff <job-id>
dcli-opencode apply --reset-author --message "feat: add input validation" <job-id>
```

### Follow up on a completed review

```powershell
$budget = 600
"Now address the security concerns you raised." |
  dcli-opencode resume <job-id> --kind continue_backend_session --hard-timeout-sec $budget
```
