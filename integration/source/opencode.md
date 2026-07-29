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

### cleanup

```
dcli-opencode cleanup [--older-than <Nd|Nh>] [--dry-run] [--scrub-session-ids]
```

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
