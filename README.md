# dcli

Delegate bounded work from Claude Code to a *different* coding-agent CLI, and get a durable, inspectable result
back.

**Status: core commands and all three adapters are implemented.** Codex and Claude pass live result paths;
opencode has one open lifecycle blocker: repeated `unknown` session status can run until the hard timeout
([ticket 81](docs/tickets/81-opencode-unknown-status-never-terminates.md)). Start at [`docs/tickets/`](docs/tickets/).

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

# resume — continue a backend conversation (piped)
"Now critique your own plan." | dcli-opencode resume <job-id> --kind continue_backend_session --hard-timeout-sec 600

# resume — continue with a prompt file (always works)
dcli-opencode resume <job-id> --kind continue_backend_session --prompt-file followup.txt --hard-timeout-sec 600

# resume — retry after a transient failure
dcli-opencode resume <job-id> --kind retry_attempt --hard-timeout-sec 600 "Re-run the same analysis"

# resume — fork from a completed result
dcli-opencode resume <job-id> --kind fork_from_artifacts --hard-timeout-sec 600 "Build on what you found"
```

Every recipe carries an execution budget and a wait budget. That is not decoration — an unbounded wait once cost a
user eight hours.

## Design principles

- **Every wait is bounded.** Every wait, read, lock, HTTP call, and drain has a finite default. A job blocked on a
  permission decision is reported as *blocked*, with the permission named — not as a timeout. The known opencode
  `unknown`-status lifecycle defect remains tracked in ticket 81.
- **Nothing is applied automatically.** Delegated changes land in an isolated git worktree. You inspect the diff
  and decide. There is no automatic path to `apply`, at any policy checkpoint.
- **Differences are stated, not hidden.** An option a backend cannot serve fails immediately, naming the
  alternative, before any job is created. Options whose *meaning* differs get backend-qualified names rather than
  one flag with three meanings.
- **A parse failure is never a pass.** An unreadable review appendix reports `malformed` — never "no findings".
- **Reduced coverage is always announced.** Truncated diffs and excluded untracked files are reported, not silent.

## One thing it deliberately does not promise

**Running jobs do not survive a wrapper crash.** If the controlling process dies, the job's process tree is killed
and the attempt is marked `interrupted`; `resume` then starts a *new* attempt from durable inputs. The alternative
would require a reconnectable process supervisor, and that complexity was judged worse than the honest limitation.

## Documentation

`README.md` is user-facing. If you are developing, start with [`AGENTS.md`](AGENTS.md) — it is the standing rules,
and every line of it was paid for by a real bug.

| For | Read |
|---|---|
| Picking up one unit of work | [`docs/tickets/`](docs/tickets/) |
| Product intent and user stories | [`docs/2026-07-28-spec.md`](docs/2026-07-28-spec.md) |
| Why the architecture is this way | [`docs/2026-07-28-architecture-decisions.md`](docs/2026-07-28-architecture-decisions.md) |
| What was challenged, and what changed | [`docs/2026-07-28-architecture-review-record.md`](docs/2026-07-28-architecture-review-record.md) |
| Binding contracts | [`docs/2026-07-28-design-spec.md`](docs/2026-07-28-design-spec.md) |
| Development pitfalls and phase order | [`docs/2026-07-28-development-guide.md`](docs/2026-07-28-development-guide.md) |
| What a backend CLI actually accepts | [`docs/reference/`](docs/reference/) |
| Verified facts about opencode, and what is not verified | [`docs/2026-07-28-opencode-cli-study.md`](docs/2026-07-28-opencode-cli-study.md) |

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
