<!-- dcli:codex skill -->

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
- **Independently verify every finding.** Never present a delegated review's raw output as your own conclusion. Triage each finding: adopt with action, or reject with a stated reason.
- **Use exact wrapper lineage.** Use `resume <job-id> --kind continue_backend_session` for follow-ups. Never "continue last session" — it is ambiguous and can attach to the wrong conversation.
- **React per the failure-class table.** Never retry quota, auth, permission, or timeout failures. A `findings_status: malformed` report is not a clean review — it means the output was unparseable.
- **Keep review intent neutral.** Intent is context, not evidence of correctness.
- **Keep delegated work out of your context until collection.** When token saving is the point, use `submit` + later `read` rather than `run`.

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

A review result may carry a machine-readable findings appendix:

```json
<!-- dcli:findings -->
{
  "verdict": "One-line verdict.",
  "items": [
    { "severity": "critical|important|minor",
      "file": "relative/path.ts", "line": 42,
      "claim": "One-sentence defect claim.",
      "evidence": "Why this is real and reachable.",
      "suggested_fix": "Concrete correction." }
  ]
}
```

- `findings_status: ok` — findings were parsed successfully
- `findings_status: absent` — no findings appendix found (reviewer found nothing or chose not to produce structured output)
- `findings_status: malformed` — an appendix was found but could not be parsed. This is **not** a clean review.
- Truncated or duplicate markers are `malformed`, not clean.


# dcli-codex skill

Backend: codex (codex exec --json, prompt on stdin)

## Capabilities

| Capability | Supported |
|---|---|
| Interactive permissions | No — sandbox mode is the only access control |
| Graceful cancel | No — only hard kill |
| Structured output | Yes (`--output-schema`) — but unused; wrapper uses text-based findings |
| Effort/reasoning | `--effort <level>` (enum: none, minimal, low, medium, high, xhigh, max, ultra) |

## Flags specific to this backend

- `--effort <level>` — reasoning effort level (use instead of `--variant` or `--reasoning-effort`)

## Commands

### review

```
dcli-codex review [--working|--staged|--range <base>..<head>] [--path <p>] [--intent <s>] [--focus <s>] [--embed-diff] [--include-untracked] --hard-timeout-sec <n>
```

### ask / brainstorm

```
echo "Question or prompt" | dcli-codex run --hard-timeout-sec <n>
```

### implement

```
echo "Description of change" | dcli-codex run --mode implement --access workspace --hard-timeout-sec <n>
dcli-codex diff <job-id> --stat
dcli-codex diff <job-id>
dcli-codex apply [--reset-author] [--message <s>] <job-id>
```

### resume

```
echo "Follow-up" | dcli-codex resume <job-id> --kind continue_backend_session --hard-timeout-sec <n>
```

### jobs (status / list / wait)

```
dcli-codex status <job-id>
dcli-codex list
dcli-codex wait <job-id> --timeout-sec <n>
dcli-codex wait --all --group <g> --timeout-sec <n>
```

### doctor

```
dcli-codex doctor --json
```

### cleanup

```
dcli-codex cleanup [--older-than <Nd|Nh>] [--dry-run]
```

## Recipes

### Review a branch (with budgets)

```powershell
$budget = 900
dcli-codex review --range main..HEAD --intent "Review the refactoring" --hard-timeout-sec $budget
```

### Background implementation

```powershell
$budget = 1800
echo "Refactor the database layer" |
  dcli-codex submit --mode implement --access workspace --group nightly --hard-timeout-sec $budget
dcli-codex wait --all --group nightly --timeout-sec $budget --json
```

### Inspect and apply

```powershell
dcli-codex diff <job-id> --stat
dcli-codex diff <job-id>
dcli-codex apply --message "refactor: database layer" <job-id>
```

### Continue a session

```powershell
$budget = 600
echo "Review the error handling too" |
  dcli-codex resume <job-id> --kind continue_backend_session --hard-timeout-sec $budget
```
