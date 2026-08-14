# dcli-claude skill

Backend: claude (Claude Code -p --output-format stream-json)

## Capabilities

| Capability | Supported |
|---|---|
| Interactive permissions | No — unattended mode only |
| Graceful cancel | No — only hard kill |
| Structured output | Yes (`--json-schema`) — but unused; wrapper uses text-based findings |
| Effort/reasoning | `--effort <level>` (preferred) or `--reasoning-effort <level>` (accepted compatibility alias); enum: low, medium, high, xhigh, max |

## Flags specific to this backend

- `--effort <level>` — preferred spelling. `--reasoning-effort <level>` is an accepted compatibility alias for the same setting; if both are supplied, `--effort` wins. `--variant` is rejected. A value outside the enum is rejected with exit `2` before a job is created.

## Spend cap

Every invocation is launched with `--max-budget-usd 20`. The value is fixed in the
adapter; no dcli flag raises or lowers it. So a single delegation can cost up to
USD 20, and a job that stops early may have hit that cap rather than finished the
work — check the result before assuming the task was completed. Keep
`--hard-timeout-sec` tight and scope the prompt when cost matters.

## Commands

### review

```
dcli-claude review [--working|--staged|--range <base>..<head>] [--path <p>] [--intent <s>] [--focus <s>] [--no-embed-diff] [--include-untracked] --hard-timeout-sec <n>
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
dcli-claude apply [--reset-author] [--message <s>] [--allow-untracked] <job-id>
```

### resume

```
echo "Follow-up" | dcli-claude resume <job-id> --kind continue_backend_session --hard-timeout-sec <n>
```

### submit --resume

`submit --resume <job-id>` creates a **detached** child job with the fixed strategy
`fork_from_artifacts`: in implement mode its worktree is seeded from the parent's result commit, and it
inherits the parent's group, label and access unless overridden. It does **not** continue the backend
session. For conversational continuation use `resume <job-id> --kind continue_backend_session`.
`--kind` does not apply to `submit`.

### jobs

```
dcli-claude status <job-id>
dcli-claude list
dcli-claude wait <job-id> --timeout-sec <n>
dcli-claude wait --all --group <g> --timeout-sec <n>
```

### doctor

```
dcli-claude doctor --json [--live-smoke-timeout-sec <n>]
```

The command runs a bounded live smoke by default. Use timeout `0` only for an
explicitly reported static-only check.

### cleanup

```
dcli-claude cleanup [--older-than <Nd|Nh>] [--dry-run] [--scrub-session-ids]
```

`N` must be a positive integer; `d` means days and `h` means hours.

If `--older-than` is omitted, `cleanup` includes eligible terminal jobs of **every** age. Run with
`--dry-run` first.

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

### Background implementation

`submit --mode implement` honours implement mode: a worktree is prepared at
submit time, the detached worker runs inside it, and `diff`/`apply` work on
the job exactly as for `run --mode implement`.

```powershell
$budget = 1800
echo "Description" |
  dcli-claude submit --mode implement --access workspace --group nightly --hard-timeout-sec $budget
dcli-claude wait --all --group nightly --timeout-sec $budget --json
dcli-claude diff <job-id>
dcli-claude apply <job-id>
```
