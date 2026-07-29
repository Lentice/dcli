---
name: dcli-claude
description: Delegate bounded work to another Claude Code session. Use for review, ask, and implement delegation through the claude backend.
---

<!-- dcli:claude skill -->

# Core delegation patterns (shared by all backends)

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

## Preferred patterns

- **Submit long tasks to the background** with `submit`. Use `wait --all --group <group>` to gather results, never a hand-rolled poll loop.
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
- **A wait without `--timeout-sec` is a defect**, even in a throwaway one-liner.
  An unbounded wait once consumed an entire working session while the backend's
  result had been sitting complete for minutes.

## Cancelling and cleaning up

- **Preview before deleting.** Run `cleanup --dry-run` first and read what it
  lists. Retention once removed a worktree mid-operation and destroyed the only
  artifact needed to retry the work.
- **A cancel is not confirmed until the state says so.** Exit 21 means
  cancellation could not be confirmed — check `status` rather than assuming the
  job is dead.
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
| 2 | Usage/validation error | Fix the invocation. No job was created. |
| 3 | Job not found | Check the job ID. |
| 4 | Job not terminal | Wait longer or check status. |
| 10 | Backend execution failed | Read `failure_reason` for details. |
| 11 | No usable result | Preserve events; resume or retry. |
| 12 | Environment/compatibility failure | Run `doctor` for diagnostics. |
| 13 | Authentication failure | Run `<backend> login` / `auth`. Never retry automatically. |
| 14 | Quota or rate-limit | Note it; continue without the work. Never retry. |
| 15 | Permission/access denied | Refine the permission profile. Never retry automatically. |
| 16 | Network failure | At most one jittered retry for read-only jobs only. |
| 20 | Wait timed out | Job still active; increase `--timeout-sec` or check later. |
| 21 | Cancellation unconfirmed | Check job status manually. |
| 22 | Session expired | Start a fresh job with `fork_from_artifacts` or `retry_attempt`. |
| 23 | Repo/worktree preparation failure | Check repo health, run `doctor`. |
| 24 | Hard timeout | Process tree killed. Increase `--hard-timeout-sec` if the task legitimately needs more time. |
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


# dcli-claude skill

Backend: claude (Claude Code -p --output-format stream-json)

## Capabilities

| Capability | Supported |
|---|---|
| Interactive permissions | No — unattended mode only |
| Graceful cancel | No — only hard kill |
| Structured output | Yes (`--json-schema`) — but unused; wrapper uses text-based findings |
| Effort/reasoning | `--reasoning-effort <level>` (enum: low, medium, high, xhigh, max) |

## Flags specific to this backend

- `--reasoning-effort <level>` — reasoning effort level (use instead of `--variant` or `--effort`)

## Commands

### review

```
dcli-claude review [--working|--staged|--range <base>..<head>] [--path <p>] [--intent <s>] [--focus <s>] [--embed-diff] [--include-untracked] --hard-timeout-sec <n>
```

### ask / brainstorm

```
echo "Question" | dcli-claude run --hard-timeout-sec <n>
```

### implement

```
echo "Description" | dcli-claude run --mode implement --access workspace --hard-timeout-sec <n>
dcli-claude diff <job-id>
dcli-claude apply <job-id>
```

### resume

```
echo "Follow-up" | dcli-claude resume <job-id> --kind continue_backend_session --hard-timeout-sec <n>
```

### jobs

```
dcli-claude status <job-id>
dcli-claude list
dcli-claude wait <job-id> --timeout-sec <n>
dcli-claude wait --all --group <g> --timeout-sec <n>
```

### doctor

```
dcli-claude doctor --json
```

### cleanup

```
dcli-claude cleanup [--older-than <Nd|Nh>] [--dry-run]
```

## Recipes

### Get a second opinion

```powershell
$budget = 900
"Critique this architecture." |
  dcli-claude run --hard-timeout-sec $budget
```

### Review changes

```powershell
$budget = 900
dcli-claude review --working --intent "Check for regressions" --hard-timeout-sec $budget
```

### Background a test suite

```powershell
$budget = 3600
"Run the test suite and report." |
  dcli-claude submit --access workspace --group nightly --hard-timeout-sec $budget
dcli-claude wait --all --group nightly --timeout-sec 3600 --json
```
