# dcli-opencode skill

Backend: opencode (opencode serve per job over HTTP)

## Capabilities

| Capability | Supported |
|---|---|
| Interactive permissions | Detected, never answered — see below |
| Graceful cancel | Yes — session abort, server dispose, then hard kill |
| Structured output | Broken — use wrapper-side findings extraction |
| Effort/reasoning | `--variant <string>` (unbounded, provider-specific) |

## Flags specific to this backend

- `--variant <string>` — provider-specific reasoning variant (use instead of `--reasoning-effort`)

## Interactions are auto-rejected

The transport can see a mid-run permission request or question, but nothing can
answer one: there is no CLI command for replying, and the automation policy that
would grant a request is never populated. Every pending interaction is rejected
automatically, recorded as `rejected_unattended`, and reported as a
`permission_or_sandbox` backend error.

So do not send opencode work that will need to ask for anything — an extra grant,
a clarifying question, a confirmation. It will not stall waiting for you; it will
be refused and the job will burn its budget failing. Grant what the task needs up
front through `--access`, and scope the prompt so no question is required.

## Default model

Omitting `--model` does **not** fall back to the user's own opencode default. The
adapter selects `opencode-go/deepseek-v4-flash`. That is a specific provider,
quality level, and billing path — pass `--model <provider>/<id>` explicitly
whenever the choice matters for the task.

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
- `fork_from_artifacts` — a fresh session whose worktree starts from the parent's
  result commit. The seed applies only with `--mode implement`, and only if the
  parent actually produced a result commit; otherwise the new attempt starts from
  `HEAD` and carries nothing forward from the parent.
- `retry_attempt` — a fresh session and a new attempt. It does **not** replay the
  parent's request: the prompt you pass on this call is the prompt that runs, so
  resend the original text if you want the original request.

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
