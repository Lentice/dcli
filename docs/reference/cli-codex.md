# CLI reference — Codex

Version studied: **codex-cli 0.145.0** (npm install; `codex.cmd` + `codex.ps1` shims on Windows).
Captured 2026-07-28. The production wrapper for this backend today is `ccodex`; its behavioral
contracts are in that repo's `docs/2026-07-08-ccodex-reference.md`.

Re-derive this file on every Codex upgrade — `ccodex` needed a dedicated `codex-upgrade-check`
skill for exactly this reason.

---

## Command tree

```
exec            Run Codex non-interactively            [alias: e]
  exec resume     Resume a previous session by id, or --last
  exec review     Run a code review against the current repository
review          Run a code review non-interactively
login [status]  Manage login
logout
mcp             External MCP servers
plugin          Codex plugins
mcp-server      Run Codex as an MCP server (stdio)
app-server      [experimental]
remote-control  [experimental] manage the app-server daemon
app             Launch the Desktop app
completion      Shell completion scripts
update          Update Codex
doctor          Diagnose installation, config, auth, runtime health
sandbox         Run commands inside a Codex-provided sandbox
debug           models | app-server | prompt-input
apply <TASK_ID> git-apply the latest agent diff       [alias: a]
resume          Resume an interactive session (picker; --last)
fork            Fork an interactive session (picker; --last)
archive | delete | unarchive   Saved-session management
cloud           [EXPERIMENTAL] Codex Cloud tasks
exec-server     [EXPERIMENTAL]
features        list | enable | disable
```

If no subcommand is given, options are forwarded to the interactive TUI.

---

## Options common to most subcommands

| Flag | Type | Notes |
|---|---|---|
| `-c, --config <key=value>` | repeatable | Override `~/.codex/config.toml`. Dotted path for nested values. Value parsed as **TOML**; falls back to a literal string. e.g. `-c model="o3"`, `-c 'sandbox_permissions=["disk-full-read-access"]'` |
| `--enable <FEATURE>` | repeatable | = `-c features.<name>=true` |
| `--disable <FEATURE>` | repeatable | = `-c features.<name>=false` |
| `--strict-config` | bool | Error on unrecognized `config.toml` fields |
| `-i, --image <FILE>...` | | attach image(s) to the initial prompt |
| `-m, --model <MODEL>` | | |
| `--oss` | bool | use open-source provider |
| `--local-provider <P>` | | `lmstudio` \| `ollama` |
| `-p, --profile <NAME>` | | layer `$CODEX_HOME/<name>.config.toml` over base config |
| `-s, --sandbox <MODE>` | enum | `read-only` \| `workspace-write` \| `danger-full-access` |
| `--dangerously-bypass-approvals-and-sandbox` | bool | **EXTREMELY DANGEROUS** — no prompts, no sandbox |
| `--dangerously-bypass-hook-trust` | bool | **DANGEROUS** — run hooks without persisted trust |
| `-C, --cd <DIR>` | | agent working root |
| `--add-dir <DIR>` | | additional writable directories |
| `-a, --ask-for-approval <POLICY>` | enum | `untrusted` \| `on-request` \| `never` |
| `--search` | bool | enable native web search (no per-call approval) |

### Reasoning effort is NOT a flag

Codex's native CLI has **no `--effort` flag**. The dcli wrapper exposes `--effort` (preferred) and
`--reasoning-effort` (accepted compatibility alias); effort is passed to Codex through config:

```
-c model_reasoning_effort=<level>
```

as a single `-c` pair (this is exactly what `ccodex` does). Observed enum on 0.144.1:
`none | minimal | low | medium | high | xhigh | max | ultra`. **Re-derive on every upgrade** — this
enum has already changed once.

This is why the wrapper validates effort per backend rather than treating the native flag spelling as
shared across backends (ADR-004).

---

## `codex exec [PROMPT]` — the non-interactive workhorse

Prompt handling: positional `PROMPT`, or **read from stdin** when omitted or when `-` is used.
If stdin is piped *and* a prompt is given, stdin is appended as a `<stdin>` block.

Adds, beyond the common options:

| Flag | Type | Notes |
|---|---|---|
| `--skip-git-repo-check` | bool | allow running outside a git repository |
| `--ephemeral` | bool | do not persist session files to disk |
| `--ignore-user-config` | bool | do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME` |
| `--ignore-rules` | bool | do not load user/project execpolicy `.rules` files |
| `--output-schema <FILE>` | path | **JSON Schema file describing the final response shape** |
| `--color <COLOR>` | enum | `always` \| `never` \| `auto` (default `auto`) |
| `--json` | bool | print events to stdout as **JSONL** |
| `-o, --output-last-message <FILE>` | path | write the agent's last message to a file |

`--ignore-user-config` + `--ignore-rules` + `--ephemeral` together give a clean, reproducible,
non-persisting run — valuable for wrapper jobs that must not be perturbed by user config.

`--output-schema` is Codex's **working** structured-output mechanism, unlike opencode's (study §8).
It still must not be exposed as a generic shared flag (ADR-004): the three backends' mechanisms are
a file path, a broken API field, and an inline JSON string respectively.

### `codex exec resume [SESSION_ID] [PROMPT]`

`SESSION_ID` is a UUID or a thread name (UUIDs win if it parses). `PROMPT` may be `-` for stdin.
`--last` resumes the newest recorded session; `--all` disables cwd filtering.

### `codex exec review`

A code review against the current repository, inside the non-interactive path.

---

## `codex review [PROMPT]` — native review

| Flag | Notes |
|---|---|
| `--uncommitted` | review staged, unstaged, and untracked changes |
| `--base <BRANCH>` | review against a base branch |
| `--commit <SHA>` | review the changes a commit introduced |
| `--title <TITLE>` | commit title shown in the review summary |

`PROMPT` = custom review instructions; `-` reads from stdin.

**The wrapper does not use this.** `dcli review` composes its own prompt and embeds a
wrapper-generated diff (`--embed-diff`, spec §11) so the findings contract and scoping are identical
across all three backends. Native review is recorded as a namespaced extension.

---

## `codex resume` / `codex fork` (interactive)

`[SESSION_ID] [PROMPT]`, plus `--last`, `--all`, `--include-non-interactive` (resume only),
`--remote <ADDR>`, `--remote-auth-token-env <ENV_VAR>`, and the common options.
Interactive TUI paths — the wrapper uses `exec resume`, not these.

## `codex apply <TASK_ID>`

`git apply`s the latest diff produced by a Codex agent onto the local working tree.
**Not used** — the wrapper owns worktree isolation and its own `apply` with rollback (spec §12).

## `codex doctor`

`--json` (redacted machine-readable report), `--summary`, `--all`, `--no-color`, `--ascii`.
`dcli-codex doctor` delegates to this; `dcli doctor` should too, for the codex adapter.

## `codex sandbox [COMMAND]...`

Runs a command under the Codex sandbox (on Windows, a restricted token).
`--sandbox-state-json <JSON>`, `--sandbox-state-readable-root <ROOT>` (repeatable),
`--sandbox-state-disable-network`, `-P/--permission-profile <NAME>`, `-p/--profile`, `-C/--cd`,
`--include-managed-config`.

Useful as a **spawn-capability probe** — see "Host quirks" below.

## `codex login` / `logout`

`login [status]`, `--with-api-key` (reads from stdin), `--with-access-token` (stdin),
`--device-auth`. **Auth remediation hint: `codex login`.**

## `codex debug`

`models` (raw model catalog as JSON), `app-server`, `prompt-input` (model-visible prompt input list
as JSON).

## `codex features`

`list` (features with stage and effective state), `enable`, `disable`.

---

## Wrapper mapping

| Wrapper concept | Codex mechanism |
|---|---|
| execution | `codex exec --json` with prompt on **stdin** |
| final result | `-o/--output-last-message <file>` |
| event stream | `--json` → JSONL on stdout |
| model | `-m/--model` |
| reasoning effort | `-c model_reasoning_effort=<level>` — surfaced as `dcli-codex --effort`; `--reasoning-effort` is an accepted compatibility alias |
| access `read-only` | `-c sandbox_mode="read-only"` (plus `-s read-only`, see below) |
| access `workspace` | `-c sandbox_mode="workspace-write"` **and** `-c approvals_reviewer="auto_review"` |
| approval policy | no `-a` flag exists on `exec`; the reviewer config above is the only lever |
| working directory | `-C/--cd <dir>` |
| resume | `codex exec resume <SESSION_ID>` |
| clean/reproducible run | `--ignore-user-config --ignore-rules --ephemeral` |
| structured output | `--output-schema <FILE>` (works; still not a shared flag) |
| doctor | `codex doctor --json` |
| dcli doctor live smoke | `dcli-codex doctor` starts `codex exec`, sends a trivial request, and reports `ok`, `coverage`, and `live_smoke_timeout_sec`; timeout `0` is static-only |
| auth remediation | `codex login` |
| cancellation | no graceful API — **process-tree kill only** |
| interactive permission reply | **not possible** in this execution model |

Note the asymmetry that ADR-004 exists to protect: Codex has **no** graceful cancel and **no**
runtime permission reply, while opencode has both. A shared `--approval ask` or a shared
"cancel means abort" promise would be a lie on this backend.

**`dcli cancel <job-id>` reaches a foreground `run`/`resume` too.** The running
attempt watches the same `cancel.request` file the detached worker watches, so
a foreground job and a backgrounded one both end `cancelled`.

`submit --resume <job-id>` creates a **detached** child job with the fixed strategy
`fork_from_artifacts`: in implement mode its worktree is seeded from the parent's result commit, and it
inherits the parent's group, label and access unless overridden. It does **not** continue the backend
session. For conversational continuation use `resume <job-id> --kind continue_backend_session`.
`--kind` does not apply to `submit`.

## dcli wrapper cleanup

The wrapper command is:

```text
dcli-codex cleanup [--older-than <Nd|Nh>] [--dry-run] [--scrub-session-ids]
```

`N` must be a positive integer; `d` means days and `h` means hours.

If `--older-than` is omitted, `cleanup` includes eligible terminal jobs of **every** age. Run with
`--dry-run` first.

For eligible terminal implement jobs it removes the job record, isolated
worktree, and git registration together. It also discovers orphan worktrees
under the dcli state root. `--dry-run` names each worktree and reports its
bytes; worktrees held by `diff` or `apply` are named and skipped.

`--scrub-session-ids` blanks the recorded backend session id on terminal jobs
only. The scrub is durable: it is journaled, so a later status read that
regenerates the record from the journal still reports the id blank.

## Background implementation recipe

`submit --mode implement` is honoured: the worktree is prepared at submit time
on the same path `run --mode implement` uses, the detached worker runs inside
it, and `diff`/`apply` work on the submitted job. Execution budget
`--hard-timeout-sec` and caller-side wait budget `--timeout-sec` are both set:

```powershell
$budget = 1800
echo "Refactor the database layer" |
  dcli-codex submit --mode implement --access workspace --group nightly --hard-timeout-sec $budget
dcli-codex wait --all --group nightly --timeout-sec $budget --json
dcli-codex diff <job-id> --stat
dcli-codex diff <job-id>
dcli-codex apply [--reset-author] [--message <s>] [--allow-untracked] <job-id>
```

---

## Host quirks (this development machine)

- **Windows shim resolution.** npm installs both `codex.cmd` and `codex.ps1`. PowerShell ranks the
  ExternalScript above the Application, so a bare lookup returns the `.ps1`, which `Process.Start`
  cannot execute. Resolve deliberately to the executable (development guide §1.9).
- **Node cannot spawn `.cmd` directly.** Since the Node 18.20 / 20.12 security fix, `spawn("codex.cmd", …)`
  fails with **`EINVAL`** — verified on Node v24.18.0 on this host. The only correct form is to spawn
  `%ComSpec%` explicitly with `/d /s /c` and a pre-quoted inner line (`shell: true` would also work and is
  banned). Since npm installs `codex.cmd` on Windows, this is on the main path.- **cmd.exe shim quoting is two-layered.** When the resolved binary is a `.cmd`/`.bat`, the
  invocation is wrapped `cmd /d /s /c "<inner line>"`; the inner line needs Win32 quoting **plus**
  force-quoting of cmd metacharacters (`& | < > ( ) ^ %`), assigned as one pre-quoted string so the
  runtime does not re-escape it. Do not fork a second quoting implementation for the detach path.
- **`-s/--sandbox` is not load-bearing under `--ignore-user-config`.** Verified live on codex-cli
  0.146.0, both directions: `-s read-only` still wrote files (the machine's `config.toml` said
  `workspace-write`), and `-s workspace-write` was refused with *"writing is blocked by read-only
  sandbox"*. `-c sandbox_mode="<mode>"` does take effect and is therefore authoritative; `-s` is kept
  only because it agrees. The dangerous half is the first one: passing `-s read-only` and nothing else
  does **not** sandbox the child.
- **Write access additionally needs `-c approvals_reviewer="auto_review"`.** With `--ignore-user-config`,
  `workspace-write` alone had every patch auto-rejected — *"rejected by user approval settings"* — and
  `codex exec` has no approval channel to answer with, so the job completed cleanly having written
  nothing. `approval_policy`, `projects.<dir>.trust_level` and `sandbox_workspace_write.writable_roots`
  were each probed live and none of them lifted the rejection; only the reviewer setting did.
  Never pass it for `read-only`.
- **Sandbox spawn capability has changed across versions.** Under 0.142.5 the sandbox could not
  spawn child processes on this host (signature: `CreateProcessWithLogonW failed: 1385`), which made
  a wrapper-embedded diff mandatory. Re-verified working on 0.144.1. `--embed-diff` remains the
  robust default regardless; if the signature reappears, restore the hard requirement and re-probe
  with `codex sandbox`.
- **The process tree is deep and lingers.** Observed live: `cmd.exe` → `node.exe` → `codex.exe` →
  a long-lived `pwsh.exe -EncodedCommand` command-safety parser. During this study a job's turn
  completed and its result file was written, yet the tree stayed alive **14+ minutes** because that
  `pwsh` helper never exited. This is the concrete source of the "`phase` is not terminal" rule
  (development guide §1.4) and of the requirement to kill innermost-first.
- **Quota exhaustion is a real observed event**: wrapper exit `10` with
  `failure_reason = quota_or_rate_limit`. Report and continue; never retry-loop.

## Amendment 2026-07-29 — where Codex reads integration files from

Asked of the running Codex CLI itself and cross-checked against its own docs. This is why the
installer's `agents` target ships **skills only**, and why `commands\` and `rules\` stay Claude-only.

| Surface | Codex reads | dcli ships there? |
|---|---|---|
| Skills | `~\.agents\skills\<name>\SKILL.md` (the standardized cross-agent root; `~\.codex\skills` also works on this host) | **yes** — the installer's `agents` target |
| Custom prompts | `$CODEX_HOME\prompts\*.md`, **top level only**, invoked as `/prompts:<file>`; deprecated in favor of skills | **no** — dcli's commands are namespaced `commands\dcli-<backend>\*.md`, and nested directories are not scanned |
| Rules | `~\.codex\rules\*.rules` — Starlark **execpolicy** (`prefix_rule(...)` → allow/prompt/forbidden), experimental | **no** — `rules\dcli-delegation.md` is agent instructions, not an execution policy, and `.md` is not an accepted extension there |
| Agent instructions | `$CODEX_HOME\AGENTS.override.md` else `$CODEX_HOME\AGENTS.md`, plus project `AGENTS.md` walking root→cwd | **no** — appending to a user's own instruction file is foreign-content mutation |

Skill discovery reads `name` and `description` from `SKILL.md` YAML frontmatter — the same two keys
Claude Code reads. Since both hosts share `~\.agents\skills`, a generated skill missing frontmatter is
installed but effectively invisible; `generate-integration.js --check` now enforces both keys.

Prompt input, confirming the stdin path already in use: `codex exec -` reads the prompt from stdin, and
that is the documented way to pass a large prompt. There is **no** `--prompt-file`-style flag, and the
argv positional form is subject to OS command-line length limits. `--output-last-message` is output only.

## Observed exit codes

Codex's own exit codes are not a granular contract; `ccodex` translates them. Notable: the wrapper's
`10` (backend execution failed), `11` (no usable result), `24` (hard timeout) all map onto
Codex-native failures that do not distinguish themselves by exit code alone. Wrapper exit `18` is
reserved for a launch failure before Codex starts; prompt delivery after startup is exit `10`.
