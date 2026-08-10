# dcli

Delegate bounded work from Claude Code to a *different* coding-agent CLI, and get a durable, inspectable result
back.

**Status: core commands, all three adapters, and the current ticket set are complete.** The ticket records are
archived in [`docs/tickets/`](docs/tickets/).

## Why

You are working in Claude Code and you want a genuinely independent second opinion, or a scoped code review whose
diff never enters your own context window, or a long task running in the background, or a code change made
somewhere your working tree cannot be touched. `dcli` gives you one job model for all of that, across
three backends.

| Command | Backend | Driven by |
|---|---|---|
| `dcli-opencode` | [opencode](https://opencode.ai) 1.18.7 | one `opencode serve` process per job, over HTTP |
| `dcli-codex` | Codex CLI 0.145.0 | `codex exec --json`, prompt on stdin |
| `dcli-claude` | Claude Code 2.1.220 | `claude -p --output-format stream-json` |
| `dcli --backend <b>` | any | umbrella, for scripting |

Each backend also installs **its own** skill, generated from one source — so an agent reading a skill
sees exactly one coherent surface and never assumes a sibling backend's flag exists.

## Setup

Two sequenced steps, from a clone of this repo:

```powershell
# 1. Put dcli, dcli-codex, dcli-opencode, dcli-claude on PATH
npm install -g .

# 2. Install the agent integration (skills, commands, rules)
pwsh -NoProfile -File install.ps1
```

Step 2 asks which targets to install, with **both selected by default**:

| Target | Directory | Receives | Read by |
|---|---|---|---|
| `claude` | `~\.claude` | skills, commands, rules, worker prompts | Claude Code |
| `agents` | `~\.agents` | skills only | any CLI that reads the shared skills root, including the Codex CLI |

`commands\` and `rules\` are Claude Code layouts and go only to the `claude` target: the Codex CLI's
custom-prompt directory is flat, with no `dcli-<backend>\` namespace, and its `~\.codex\rules` holds
execpolicy rules rather than agent instructions. Installing either there would place files no host reads.

To choose non-interactively, name the targets and override either directory:

```powershell
pwsh -NoProfile -File install.ps1 -Targets claude,agents -Force
pwsh -NoProfile -File install.ps1 -Targets agents -AgentsDir D:\alt\.agents -Force
```

Reinstalling is a swap, not a merge, so a file dropped in a newer version does not survive as a ghost.
The installer refuses to overwrite a file it did not write, and refuses any directory that collides
with the job-state root.

Open a **new** shell afterward — step 1 changes PATH, and an already-open shell won't pick that up. Verify with:

```powershell
dcli-opencode --help
dcli-codex --help
dcli-claude --help
```

For local development on this repo instead of a standalone install, use `npm link` in place of `npm install -g .`.

## What it does

```powershell
# the canonical shape: one synchronous run, both budgets, prompt from a file
dcli-codex run --repo D:\path\to\repo --prompt-file .\prompt.md `
  --hard-timeout-sec 900 --timeout-sec 900 --label diagnose-cache

# a second opinion, synchronously
"Compare these two designs." | dcli-opencode run --hard-timeout-sec 900

# a scoped review; the wrapper generates and embeds the diff itself
dcli-opencode review --range main..HEAD --path src/ --intent "Add cache invalidation" --hard-timeout-sec 900

# something long, in the background
"Run the full test suite." | dcli-claude submit --access workspace --hard-timeout-sec 3600
dcli-opencode wait --all --group nightly --timeout-sec 3600 --json

# a code change, isolated — you review it before it lands
dcli-codex run --mode implement --access workspace --hard-timeout-sec 1800 "Add retry logic to the fetch helper"
dcli-codex diff <job-id> --stat
dcli-codex diff <job-id>
dcli-codex apply --reset-author --message "feat: add retry logic" <job-id>

# the same change, in the background — submit honours --mode implement
"Add retry logic to the fetch helper" | dcli-codex submit --mode implement --access workspace --group nightly --hard-timeout-sec 1800
dcli-codex wait --all --group nightly --timeout-sec 1800 --json
dcli-codex diff <job-id> --stat
dcli-codex diff <job-id>
dcli-codex apply --reset-author --message "feat: add retry logic" <job-id>

# resume — continue a backend conversation (piped)
"Now critique your own plan." | dcli-opencode resume <job-id> --kind continue_backend_session --hard-timeout-sec 600

# resume — continue with a prompt file (always works)
dcli-opencode resume <job-id> --kind continue_backend_session --prompt-file followup.txt --hard-timeout-sec 600

# resume — retry after a transient failure
dcli-opencode resume <job-id> --kind retry_attempt --hard-timeout-sec 600 "Re-run the same analysis"

# resume — fork from a completed result
dcli-opencode resume <job-id> --kind fork_from_artifacts --hard-timeout-sec 600 "Build on what you found"

# preview and then remove aged jobs and their worktree artifacts (days or hours)
dcli-codex cleanup --older-than 1d --dry-run
dcli-codex cleanup --older-than 1d

# diagnose the backend with a real bounded request (120 seconds by default)
dcli-opencode doctor --json
```

Both a backgrounded `submit` and a foreground `run`/`resume` respond to `dcli cancel <job-id>`:
the running attempt watches the same `cancel.request` file `cancel` writes, so the job reaches
`cancelled` instead of `done` or `timed_out`.

Every recipe carries an execution budget and a wait budget. That is not decoration — an unbounded wait once cost a
user eight hours. The job hard-timeout default is 1800 seconds; the caller-side `wait` default is 300 seconds.
They are independent: exit 20 means only that this caller stopped waiting, while the job may still be running.
Use `wait --json` and inspect `wait_timed_out` / `wait_timeout_sec` when automation must distinguish the two.
The calling shell or tool needs its own finite timeout too, longer than `--hard-timeout-sec`.

Job ids look like `20260804T123456Z-a1b2c3d4`. Anything else is rejected as a usage error rather than
looked up — an id from another tool's runtime is not a dcli job, and `dcli list` is the list of ids
that are. Records are per repository, so read a job with the same `--repo` you submitted it with.

## Design principles

- **Every wait is bounded.** Every wait, read, lock, HTTP call, and drain has a finite default. A job blocked on a
  permission decision is reported as *blocked*, with the permission named — not as a timeout.
- **Nothing is applied automatically.** Delegated changes land in an isolated git worktree. You inspect the diff
  and decide. There is no automatic path to `apply`, at any policy checkpoint.
- **Cleanup owns the whole artifact.** For eligible terminal implement jobs, `cleanup` removes the job record,
  worktree directory, and its git registration together. It also reports and removes orphan worktrees under the
  dcli state root. Use `cleanup --dry-run` first; it lists each worktree and its byte count, while busy artifacts
  are named and skipped.
- **Differences are stated, not hidden.** An option a backend cannot serve fails immediately, naming the
  alternative, before any job is created. Options whose *meaning* differs get backend-qualified names rather than
  one flag with three meanings.
- **A parse failure is never a pass.** An unreadable review appendix reports `malformed` — never "no findings".
- **Reduced coverage is always announced.** Truncated diffs and excluded untracked files are reported, not silent.
- **`doctor` runs a live smoke by default.** It starts the selected backend, sends a trivial read-only request, and
  reports `ok`, `coverage`, and `live_smoke_timeout_sec` in its JSON envelope. Use
  `--live-smoke-timeout-sec 0` only for an explicit static-only check; the output reports that reduced coverage.

## Two things it deliberately does not promise

**Running jobs do not survive a wrapper crash.** If the controlling process dies, the attempt is marked
`interrupted`; `resume` then starts a *new* attempt from durable inputs, and never reattaches to a running backend.
The alternative would require a reconnectable process supervisor, and that complexity was judged worse than the
honest limitation.

**A budget bounds the wrapper's wait, not the backend's process tree.** `--hard-timeout-sec` and `--timeout-sec`
both bound what *dcli* does: the attempt is ended, the record is written, and control returns to you. dcli does not
currently contain the backend's process tree, so a backend that ignores cancellation — or a tool it spawned — can
outlive the job that started it. The record says so rather than claiming otherwise: a hard timeout writes
`kill_skipped: "not_contained"`, and a cancel whose rungs all fail records
`cancel_rung_reached: "containment_unavailable"`. Neither ever reports a kill that did not happen. If a job matters
enough that a survivor would be a problem, check for one before re-running it.

## Documentation

`README.md` is user-facing. If you are developing, start with [`AGENTS.md`](AGENTS.md) — it is the standing rules,
and every line of it was paid for by a real bug.

| For | Read |
|---|---|
| Current and past work items | [`docs/tickets/`](docs/tickets/) |
| Product intent and user stories | [`docs/product-spec.md`](docs/product-spec.md) |
| Why the architecture is this way | [`docs/architecture-decisions.md`](docs/architecture-decisions.md) |
| What was challenged, and what changed | [`docs/architecture-review-record.md`](docs/architecture-review-record.md) |
| Binding contracts | [`docs/design-spec.md`](docs/design-spec.md) |
| Engineering notes: lessons, backend traps, testing, spawning | [`docs/engineering/`](docs/engineering/) |
| What a backend CLI actually accepts | [`docs/reference/`](docs/reference/) |
| Verified facts about opencode, and what is not verified | [`docs/reference/opencode-study.md`](docs/reference/opencode-study.md) |

## Running tests

```powershell
node tests/run-tests.js              # quick suite; skips slow tests, lists them
node tests/run-tests.js --suite full # full suite; runs everything
```

Tests are plain Node assertion scripts checked by exit code. No test framework.

## Prior art

This design descends from `ccodex`, a complete production PowerShell tool that wrapped the Codex CLI. Its two
months of hardening — and its bugs — are why `AGENTS.md` exists. The predecessor keeps running unchanged; no job
state is migrated.
