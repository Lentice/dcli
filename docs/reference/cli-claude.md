# CLI reference — Claude Code

Version studied: **2.1.220** (`claude`). Captured 2026-07-28 on Windows 11.

This is the backend the wrapper is *invoked from*, so it is also the one with the largest overlap
risk: Claude Code has its own background-agent manager, its own worktree support, and its own
structured output. See [ADR-005](../architecture-decisions.md#adr-005) for what the
wrapper deliberately bypasses.

Re-derive this file on every Claude Code upgrade.

---

## Invocation

```
claude [options] [command] [prompt]
```

Interactive by default. **`-p/--print` is the non-interactive mode** the wrapper uses.

---

## Non-interactive core (the wrapper's path)

| Flag | Type | Notes |
|---|---|---|
| `-p, --print` | bool | print response and exit. Workspace-trust dialog is skipped in non-interactive mode (also when stdout is not a TTY). **Settings files that fail validation are silently ignored in this mode** — no error dialog. |
| `--output-format` | enum | `text` (default) \| `json` (single result) \| `stream-json` (realtime). Only with `--print`. |
| `--input-format` | enum | `text` (default) \| `stream-json` (realtime streaming input). Only with `--print`. |
| `--include-partial-messages` | bool | partial chunks as they arrive; needs `--print` + `--output-format=stream-json` |
| `--include-hook-events` | bool | all hook lifecycle events in the stream; needs `--output-format=stream-json` |
| `--forward-subagent-text` | bool | forward subagent text/thinking as messages with `parent_tool_use_id`; needs `--print` + `stream-json` |
| `--replay-user-messages` | bool | re-emit stdin user messages on stdout for acknowledgment; needs `--input-format=stream-json` **and** `--output-format=stream-json` |
| `--json-schema <schema>` | string | **JSON Schema (inline) for structured output validation** |
| `--max-turns` | number | limit agentic turns; only with `--print` |
| `--max-budget-usd <amount>` | number | cap API spend; only with `--print` |
| `--fallback-model <model>` | string | comma-separated fallback list when the default is overloaded; retries the primary each user turn; only with `--print` |
| `--no-session-persistence` | bool | sessions not saved to disk and cannot be resumed; only with `--print`. **The adapter must not pass it** — it is mutually exclusive with the `core.resume` capability this backend declares. It was passed unconditionally, so the `backend_session_id` recorded on every job named a conversation that was never written and `--kind continue_backend_session` always failed with *"No conversation found with session ID"*. |
| `--prompt-suggestions [v]` | enum | emits a `prompt_suggestion` message after each turn |

`--input-format stream-json` + `--output-format stream-json` is the **most promising candidate for a
control channel** to answer permission prompts, which would make `dcli-claude` symmetric with
`dcli-opencode`. **Unverified** — see spec §19.7. Until verified, assume `claude -p` can block the same
way opencode's CLI does and treat it as the study §5 hazard class.

## Model and effort

| Flag | Notes |
|---|---|
| `--model <model>` | alias (`fable`, `opus`, `sonnet`) or full name (`claude-fable-5`) |
| `--effort <level>` | **`low` \| `medium` \| `high` \| `xhigh` \| `max`** |
| `--betas <betas...>` | beta headers (API-key users only) |

`--effort`'s enum here differs from Codex's (`none..ultra`, and not even a flag there) and from
opencode's unbounded `--variant` string. Hence `dcli-claude --reasoning-effort low|medium|high|xhigh|max`
rather than a shared `--effort` (ADR-004).

## Permissions and tools

| Flag | Notes |
|---|---|
| `--permission-mode <mode>` | `acceptEdits` \| `auto` \| `bypassPermissions` \| `manual` \| `dontAsk` \| `plan` |
| `--allowedTools, --allowed-tools <tools...>` | comma/space-separated, e.g. `"Bash(git *) Edit"` |
| `--disallowedTools, --disallowed-tools <tools...>` | same shape |
| `--tools <tools...>` | restrict the built-in set; `""` disables all, `default` = all, or names e.g. `"Bash,Edit,Read"` |
| `--dangerously-skip-permissions` | bypass all permission checks |
| `--allow-dangerously-skip-permissions` | make bypass *available* without defaulting to it |
| `--add-dir <directories...>` | additional directories tool access is allowed in |

Isolation here is **mode + tool patterns**, structurally unlike Codex's sandbox flag and opencode's
per-session ruleset. A shared `--access read-only` is only legitimate if the wrapper defines and
*verifies* the invariant itself (ADR-004).

`dontAsk` and `auto` are the modes most relevant to unattended runs; which of them (if any) can
still block must be verified before phase 10.

## Session and continuation

| Flag | Notes |
|---|---|
| `-c, --continue` | continue the most recent conversation in the current directory |
| `-r, --resume [value]` | resume by session id, or interactive picker with an optional search term |
| `--session-id <uuid>` | use a specific session id (must be a valid UUID) |
| `--fork-session` | when resuming, create a new session id instead of reusing it |
| `--from-pr [value]` | resume a session linked to a PR by number/URL, or a picker |
| `-n, --name <name>` | display name for the session |

**The wrapper always records and reuses the exact session id.** `--continue` is ambiguous when
concurrent wrapper jobs share a directory and must not be the resume mechanism.

`--session-id` accepting a caller-supplied UUID is useful: the wrapper can assign the id up front
instead of scraping it from output.

## Prompt and context

| Flag | Notes |
|---|---|
| `--system-prompt <prompt>` | replace the system prompt |
| `--append-system-prompt <prompt>` | append to the default |
| `--exclude-dynamic-system-prompt-sections` | move per-machine sections (cwd, env, memory paths, git status) out of the system prompt into the first user message; improves cross-user prompt-cache reuse; default-system-prompt only |
| `--file <specs...>` | file resources to download at startup, `file_id:relative_path` |
| `--agent <agent>` | agent for the session; overrides the `agent` setting |
| `--agents <json>` | **inline JSON defining custom agents**, e.g. `'{"reviewer":{"description":"Reviews code","prompt":"You are a code reviewer"}}'` |

`--agents` is the cleanest way to give a wrapper job a purpose-built, minimal agent without touching
user configuration — the Claude analogue of opencode's per-session ruleset, for role rather than
permission.

## Configuration isolation

| Flag | Notes |
|---|---|
| `--bare` | Minimal mode: skips hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and `CLAUDE.md` auto-discovery. Sets `CLAUDE_CODE_SIMPLE=1`. Anthropic auth becomes strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` (**OAuth and keychain are never read**). Skills still resolve via `/skill-name`. Context must be supplied explicitly via `--system-prompt[-file]`, `--append-system-prompt[-file]`, `--add-dir`, `--mcp-config`, `--settings`, `--agents`, `--plugin-dir`. |
| `--safe-mode` | disable all customizations (CLAUDE.md, skills, plugins, hooks, MCP, commands, agents, output styles, workflows, themes, keybindings). Admin policy still applies. Sets `CLAUDE_CODE_SAFE_MODE=1`. |
| `--settings <file-or-json>` | additional settings, path or JSON string |
| `--setting-sources <sources>` | comma-separated: `user`, `project`, `local` |
| `--mcp-config <configs...>` | load MCP servers from JSON files/strings |
| `--strict-mcp-config` | only use `--mcp-config` servers |
| `--plugin-dir <path>` | session-only plugin from a directory or `.zip` (repeatable) |
| `--plugin-url <url>` | session-only plugin from a URL (repeatable) |
| `--disable-slash-commands` | disable all skills |

`--bare` is the recommended base for wrapper jobs — **but note the auth consequence**: it never
reads OAuth or the keychain, so a host authenticated only via OAuth will fail under `--bare` unless
`ANTHROPIC_API_KEY`/`apiKeyHelper` is supplied. Probe this in `doctor` rather than discovering it in
a job. `--safe-mode` additionally kills skills, which also helps satisfy the ADR-005 recursion
guard.

## Worktree

| Flag | Notes |
|---|---|
| `-w, --worktree [name]` | create a new git worktree for this session |
| `--tmux` | create a tmux session for the worktree (requires `--worktree`); iTerm2 native panes when available; `--tmux=classic` for traditional tmux |

**Not used** — the wrapper owns worktree isolation so the contract is identical on all three
backends (spec §12). Recorded as a namespaced extension.

## Diagnostics and misc

`-d/--debug [filter]` (e.g. `"api,hooks"` or `"!1p,!file"`), `--debug-file <path>`, `--verbose`,
`--ide`, `--chrome` / `--no-chrome`, `--brief` (enable `SendUserMessage`), `--ax-screen-reader`,
`--remote-control [name]`, `--remote-control-session-name-prefix <prefix>`, `-v/--version`.

## Background agents

| Flag | Notes |
|---|---|
| `--bg, --background` | start the session as a background agent and return immediately; manage with `claude agents` |

`claude agents [options]` — `--json` (active sessions as a JSON array; **does not require a TTY**),
`--all` (with `--json`, include completed), `--cwd <path>` (filter by start path), plus defaults for
dispatched sessions: `--agent`, `--model`, `--effort`, `--permission-mode`,
`--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--add-dir` (repeatable),
`--mcp-config` (repeatable), `--strict-mcp-config`, `--settings`, `--setting-sources`,
`--plugin-dir` (repeatable).

**ADR-005: bypassed by default.** This is the only backend with its own job manager; two overlapping
managers create ambiguous authority over status, results, containment, and crash recovery. Offered
later, if at all, as `dcli-claude native-agent ...`.

## Subcommands

| Command | Notes |
|---|---|
| `agents [options]` | above |
| `auth` | manage authentication — **auth remediation hint** |
| `auto-mode` | inspect/reset auto-mode classifier configuration |
| `doctor` | health check; reads settings in cwd without a trust prompt. `/doctor` in-session does a fuller, fixing checkup. **No `--json`** — output is human-only, unlike `codex doctor --json`. |
| `gateway [options]` | enterprise auth/telemetry gateway |
| `install [options] [target]` | install native build (`stable`, `latest`, or a version) |
| `mcp` | `add`, `add-json`, `add-from-claude-desktop`, `get`, `list`, `login`, `logout`, `remove`, `reset-project-choices`, `serve` |
| `plugin\|plugins` | manage plugins |
| `project purge [options] [path]` | delete all Claude Code state for a project (transcripts, tasks, file history, config entry) |
| `setup-token` | long-lived auth token (requires subscription) |
| `ultrareview [options] [target]` | cloud-hosted multi-agent review of the branch / a PR / a base branch |
| `update\|upgrade` | check and install updates |

`claude doctor` having no `--json` matters: the `dcli doctor` envelope must be built by the
adapter for this backend, not delegated as it can be for Codex.

---

## Wrapper mapping

| Wrapper concept | Claude Code mechanism |
|---|---|
| execution | `claude -p --output-format stream-json` |
| final result | last assistant message from the stream (or `--output-format json`) |
| event stream | `stream-json` on stdout |
| model | `--model` |
| reasoning effort | `--effort low..max` — surfaced as `dcli-claude --reasoning-effort` |
| access `read-only` | `--permission-mode` + `--disallowedTools`/`--tools`, wrapper-verified |
| access `workspace` | `--permission-mode acceptEdits` inside the wrapper's worktree |
| working directory | process cwd (+ `--add-dir` for extras) |
| job identity assigned up front | `--session-id <uuid>` |
| resume | `-r/--resume <session-id>`; `--fork-session` for a branch |
| clean/reproducible run | `--bare` (mind the auth consequence) or `--safe-mode` |
| structured output | `--json-schema <inline schema>` (works; still not a shared flag) |
| cost guard | `--max-budget-usd`, `--max-turns` |
| auth remediation | `claude auth` / `claude setup-token` |
| dcli doctor live smoke | `dcli-claude doctor` starts `claude -p`, sends a trivial request, and reports `ok`, `coverage`, and `live_smoke_timeout_sec`; timeout `0` is static-only |
| cancellation | no graceful API — **process-tree kill only** (native agents excepted) |
| interactive permission reply | **unverified** — possibly via `--input-format stream-json` |
| recursion guard | `DCLI_WORKER=1` + `--safe-mode`/`--disable-slash-commands` (ADR-005) |
| native worktree | `-w/--worktree` — extension, unused |
| native background jobs | `--bg` + `claude agents` — extension, bypassed |

## dcli wrapper cleanup

The wrapper command is:

```text
dcli-claude cleanup [--older-than <Nd|Nh>] [--dry-run] [--scrub-session-ids]
```

`N` must be a positive integer; `d` means days and `h` means hours.

For eligible terminal implement jobs it removes the job record, isolated
worktree, and git registration together. It also discovers orphan worktrees
under the dcli state root. `--dry-run` names each worktree and reports its
bytes; worktrees held by `diff` or `apply` are named and skipped.

---

## Host quirk: Node cannot spawn `.cmd` directly

`claude` is npm-installed and exposes `claude.cmd` on Windows. Since the Node 18.20 / 20.12 security fix,
`spawn("claude.cmd", …)` fails with **`EINVAL`** (verified on Node v24.18.0 here). Spawn `%ComSpec%` explicitly
with `/d /s /c` and a pre-quoted inner line, windowless (`windowsHide: true`). `shell: true` is banned.

`codex` has the identical npm `.cmd`-shim shape, and `adapters/codex/cmd-quoting.js` (covered by
`tests/adapters/codex/cmd-quoting.test.js`) already implements the two-layer Win32-plus-metacharacter
quoting this needs. Import that module for the Claude adapter rather than re-deriving it — a
hand-rewritten duplicate risks drifting from the one this project already got right.

## Recursion guard: `DCLI_WORKER` / `DCLI_DEPTH`

`dcli-claude` wrapping Claude Code means a worker session can rediscover the same skill and delegate
again. The wrapper's guard (ticket 27) is an environment sentinel, not a CLI flag Claude Code itself
understands:

- The adapter's `Start()` stamps `DCLI_WORKER=1` and `DCLI_DEPTH=<parentDepth + 1>` into the spawned
  `claude` child's environment (parent depth is 0 when the current process has no `DCLI_WORKER`).
- `cli/dcli-claude.js` reads both from its own `process.env` at the very start of the entrypoint —
  before argument parsing does any real work — and exits `2` if depth is at or above the configured
  limit (default 1).
- This relies on **OS environment inheritance**, not an argument or IPC channel: if the spawned
  `claude` process later shells out to `dcli-claude` again on its own (a rediscovered skill, not
  something the wrapper orchestrated), that nested process inherits the sentinel automatically and
  fails fast at startup.

Nothing in `core/`, `adapters/`, or `cli/` implements this yet — there is no existing scaffolding to
mirror, unlike most of this adapter's other mechanics.

---

## Verification results (verified 2026-07-29 on claude 2.1.220)

1. **`claude -p` does NOT block with `--permission-mode auto`** (the default in print mode).
   `auto` auto-approves safe operations without prompting. Safe unattended values: `auto`, `dontAsk`.
   `manual` can block. `--dangerously-skip-permissions` works but is not needed.
2. **`--input-format stream-json` exists** but its use as a permission control channel is not needed
   since `--permission-mode auto` handles unattended permissions. Unverified as a control channel.
3. **`--bare` breaks OAuth auth** — the help explicitly states "Anthropic auth is strictly
   ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read)."
   `--safe-mode` is the preferred base for wrapper jobs.
4. **`stream-json` event schema** (verified):
   - `system` (subtype: `init`, `hook_started`, `hook_response`) — startup metadata
   - `assistant` — message with `message.content[0].text` for response text
   - `rate_limit_event` — rate limit info
   - `result` — final event with `stop_reason`, `is_error`, `errors[]`, `permission_denials[]`,
     `total_cost_usd`, `terminal_reason`. Normal completion: `stop_reason: "end_turn"`.
     Budget exhaustion: `is_error: true`, `terminal_reason: "budget_exhausted"`.
   - `--include-partial-messages` shows partial chunks; not needed for the final result.
5. **`--json-schema` degrades gracefully** — errors are reported in the result object
   (`is_error`, `errors[]`), not crashing the session.
6. **`--safe-mode` disables all skills** — verified in a live test. A `-p` worker under
   `--safe-mode` cannot discover or invoke skills. This satisfies the recursion guard layer 2.
