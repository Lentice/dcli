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
echo "Question or prompt" | dcli-codex run --mode brainstorm --hard-timeout-sec <n>
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
dcli-codex wait <job-id>
dcli-codex wait --all --group <g>
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
  dcli-codex submit --mode implement --access workspace --hard-timeout-sec $budget
dcli-codex wait --all --group nightly --timeout-sec 3600 --json
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
