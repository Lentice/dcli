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

`run` has an execution budget, but the shell or agent tool invoking it must
also have a finite outer timeout longer than `<n>` plus startup/cleanup slack.
If that outer timeout cannot be set reliably, use `submit` and collect the
result with `wait --timeout-sec <n>` instead.

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
dcli-claude cleanup [--older-than <Nd|Nh>] [--dry-run] [--scrub-session-ids]
```

`N` must be a positive integer; `d` means days and `h` means hours.

Removes aged terminal job records and their isolated worktrees/git
registrations, and removes orphan worktrees under the dcli state root. Use
`--dry-run` first: it names each worktree and reports its bytes. Worktrees
held by a reader or repository operation are named and skipped.

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
