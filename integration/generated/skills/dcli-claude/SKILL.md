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
