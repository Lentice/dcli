# dcli-codex skill

Backend: codex (codex exec --json, prompt on stdin)

## Capabilities

| Capability | Supported |
|---|---|
| Interactive permissions | No — sandbox mode is the only access control |
| Graceful cancel | No — only hard kill |
| Structured output | Yes (`--output-schema`) — but unused; wrapper uses text-based findings |
| Effort/reasoning | `--effort <level>` (preferred) or `--reasoning-effort <level>` (accepted compatibility alias); enum: none, minimal, low, medium, high, xhigh, max, ultra |

## Flags specific to this backend

- `--effort <level>` — preferred spelling. `--reasoning-effort <level>` is an accepted compatibility alias for the same setting; if both are supplied, `--effort` wins. `--variant` is rejected. A value outside the enum is rejected with exit `2` before a job is created.

## Commands

### review

```
dcli-codex review [--working|--staged|--range <base>..<head>] [--path <p>] [--intent <s>] [--focus <s>] [--no-embed-diff] [--include-untracked] --hard-timeout-sec <n>
```

### ask / brainstorm

```
echo "Question or prompt" | dcli-codex run --hard-timeout-sec <n>
```

`run` has an execution budget, but the shell or agent tool invoking it must
also have a finite outer timeout longer than `<n>` plus startup/cleanup slack.
If that outer timeout cannot be set reliably, use `submit` and collect the
result with `wait --timeout-sec <n>` instead.

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

The same outer-timeout rule applies to synchronous `resume`. For a long
follow-up, submit a new attempt and use a bounded `wait` from the caller.

### jobs (status / list / wait)

```
dcli-codex status <job-id>
dcli-codex list
dcli-codex wait <job-id> --timeout-sec <n>
dcli-codex wait --all --group <g> --timeout-sec <n>
```

### doctor

```
dcli-codex doctor --json [--live-smoke-timeout-sec <n>]
```

The command runs a bounded live smoke by default. Use timeout `0` only for an
explicitly reported static-only check.

### cleanup

```
dcli-codex cleanup [--older-than <Nd|Nh>] [--dry-run] [--scrub-session-ids]
```

`N` must be a positive integer; `d` means days and `h` means hours.

If `--older-than` is omitted, `cleanup` includes eligible terminal jobs of **every** age. Run with
`--dry-run` first.

Removes aged terminal job records and their isolated worktrees/git
registrations, and removes orphan worktrees under the dcli state root. Use
`--dry-run` first: it names each worktree and reports its bytes. Worktrees
held by a reader or repository operation are named and skipped.

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
