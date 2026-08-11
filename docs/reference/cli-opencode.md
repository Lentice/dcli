# CLI reference — opencode

Version studied: **1.18.7** (`C:\Users\lenticetsai\.bun\bin\opencode.exe`, Bun v1.3.14).
Captured 2026-07-28 on Windows 11. Full behavioral findings: [study](opencode-study.md).

Re-derive this file on every opencode upgrade (see development guide §7).

---

## Global options

Accepted on the root command and inherited by most subcommands.

| Flag | Type | Default | Notes |
|---|---|---|---|
| `-h, --help` | bool | | |
| `-v, --version` | bool | | |
| `--print-logs` | bool | | logs to stderr |
| `--log-level` | enum | | `DEBUG` `INFO` `WARN` `ERROR` |
| `--pure` | bool | | run without external plugins |
| `--port` | number | `0` | |
| `--hostname` | string | `127.0.0.1` | |
| `--mdns` | bool | `false` | mDNS discovery; defaults hostname to `0.0.0.0` |
| `--mdns-domain` | string | `opencode.local` | |
| `--cors` | array | `[]` | additional CORS domains |
| `-m, --model` | string | | `provider/model` |
| `-c, --continue` | bool | | continue last session |
| `-s, --session` | string | | session id to continue |
| `--fork` | bool | | fork when continuing; use with `-c`/`-s` |
| `--prompt` | string | | |
| `--agent` | string | | |
| `--auto` | bool | `false` | auto-approve permissions not explicitly denied — **`(dangerous!)` per opencode's own help** |
| `--mini` | bool | `false` | minimal interactive interface |
| `--no-replay` | bool | | disable mini replay |
| `--replay-limit` | number | | cap mini replay to newest N |

`--mdns` widening the bind address to `0.0.0.0` is a security-relevant default change. Never set it.

---

## Command tree

```
completion                      generate shell completion script
acp                             ACP (Agent Client Protocol) server
mcp add|list|auth|logout|debug  MCP servers
[project]                       start TUI                       [default]
attach <url>                    attach to a running server
run [message..]                 run with a message
debug <...>                     debugging/troubleshooting
providers list|login|logout     AI providers and credentials    [alias: auth]
agent create|list               agents
upgrade [target]
uninstall
serve                           headless server
web                             server + web interface
models [provider]
stats
export [sessionID]
import <file>
github install|run
pr <number>
session list|delete
plugin <module>                 install plugin + update config  [alias: plug]
db [query]|path                 database tools
```

---

## `opencode run [message..]`

Prompt is **positional** (an array). There is no explicit stdin marker analogous to `codex exec -`.

| Flag | Type | Notes |
|---|---|---|
| `--command` | string | the command to run; `message` supplies its args |
| `-c, --continue` | bool | |
| `-s, --session` | string | |
| `--fork` | bool | requires `-c` or `-s` |
| `--share` | bool | share the session |
| `-m, --model` | string | `provider/model` |
| `--agent` | string | |
| `--format` | enum | `default` \| `json` (default `default`) — `json` = NDJSON events |
| `-f, --file` | array | file(s) to attach to the message |
| `--title` | string | session title; truncated prompt if no value |
| `--attach` | string | use a running server, e.g. `http://localhost:4096` |
| `-p, --password` | string | basic auth; defaults to `OPENCODE_SERVER_PASSWORD` |
| `-u, --username` | string | defaults to `OPENCODE_SERVER_USERNAME` or `opencode` |
| `--dir` | string | directory to run in; path on remote server when attaching |
| `--port` | number | port for the **local** server (random if no value) |
| `--variant` | string | provider-specific reasoning effort, e.g. `high`, `max`, `minimal` — **unbounded string, not an enum** |
| `--thinking` | bool | show thinking blocks |
| `-i, --interactive` | bool | direct interactive split-footer mode |
| `--auto` | bool | see global note |

**Not used in production** (ADR-002): `run` hangs forever with zero output on an `ask` permission
(study §5). Diagnostic use only.

---

## `opencode serve` / `web` / `acp`

`serve` and `web`: `--port`, `--hostname`, `--mdns`, `--mdns-domain`, `--cors`.
`acp` adds `--cwd` (defaults to the invocation directory).

`serve` startup stdout **[observed]**:

```
Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
opencode server listening on http://127.0.0.1:47311
```

This is the production backend. The HTTP surface is documented in
[study §6](opencode-study.md#6-opencode-serve--the-http-surface-observed).

---

## `opencode attach <url>`

`--dir`, `-c/--continue`, `-s/--session`, `--fork`, `-p/--password`, `-u/--username`,
`--mini`, `--no-replay`, `--replay-limit`. Starts a **TUI client** — not a machine-oriented
job command. Not used by the wrapper.

---

## `opencode session`

| Command | Options |
|---|---|
| `session list` | `-n, --max-count <number>`, `--format table\|json` (default `table`) |
| `session delete <sessionID>` | — |

`--format json` shape: `[{id, title, updated, created, projectId, directory}]`, times in epoch ms.

## `opencode export [sessionID]` / `import <file>`

`export`: `--sanitize` (redact sensitive transcript and file data).
`import <file>`: path to a JSON file or a share URL.

**Do not depend on `export`** — observed not returning within ~34 s on this host (study §3).

## `opencode agent`

| Command | Options |
|---|---|
| `agent create` | `--path`, `--description`, `--mode all\|primary\|subagent`, `--permissions`/`--tools` (comma-separated), `-m/--model` |
| `agent list` | — |

`--permissions` allowed values: `bash, read, edit, glob, grep, webfetch, task, todowrite,
websearch, lsp, skill`. This is a **coarse allow-list** — not the same mechanism as the per-session
`PermissionRuleset` used by the wrapper (study §7).

## `opencode models [provider]`

`--verbose` (include cost metadata), `--refresh` (refresh cache from models.dev).
Positional `provider` filters.

## `opencode stats`

`--days <n>`, `--tools <n>`, `--models [n]`, `--project [name]` (empty string = current project).

## `opencode providers` (alias `auth`)

| Command | Options |
|---|---|
| `providers list` (alias `ls`) | — |
| `providers login [url]` | `-p/--provider`, `-m/--method` |
| `providers logout [provider]` | — |

Credentials live in `~/.local/share/opencode/auth.json`.
**Auth remediation hint for `failure_reason: auth`: `opencode providers login`.**

## `opencode mcp`

`add [name]` (`--url`, `--env KEY=VALUE` repeatable, `--header KEY=VALUE` repeatable),
`list` (alias `ls`), `auth [name]`, `logout [name]`, `debug <name>`.

## `opencode plugin <module>`

`-g/--global`, `-f/--force`. Installs an npm module and updates config.

## `opencode db`

`db [query]` — `--format json|tsv` (default `tsv`); `db path` prints the SQLite path.
Tables include `project`, `project_directory`, `session`, `message`, `part`, `session_message`,
`session_input`, `session_context_epoch`, `permission`, `todo`, `workspace`, `event`,
`event_sequence`.

**Never a normal wrapper read path** — implementation detail, contains credentials and transcripts.
`doctor --deep` only, read-only, redacted.

## `opencode debug`

| Command | Purpose |
|---|---|
| `debug config` | resolved configuration |
| `debug lsp` | LSP utilities (`diagnostics <file>`, `symbols <query>`, `document-symbols <uri>`) |
| `debug rg` | ripgrep utilities (`files`, `search <pattern>`) |
| `debug file` | fs utilities (`read <path>`, `list <path>`, `search <query>`) |
| `debug scrap` | list all known projects |
| `debug skill` | list available skills |
| `debug snapshot` | `track`, `patch <hash>`, `diff <hash>` |
| `debug startup` | startup timing |
| `debug agent <name>` | agent configuration details |
| `debug v2` | v2 catalog and built-in plugins |
| `debug info` | version, OS, plugins |
| `debug paths` | data/config/cache/state/log/tmp paths |
| `debug wait` | **wait indefinitely** — a ready-made hang fixture for tests |

## `opencode github` / `pr`

`github install`, `github run` (`--event`, `--token`). `pr <number>` checks out a PR branch then
runs opencode. Not used by the wrapper.

---

## Wrapper mapping

| Wrapper concept | opencode mechanism |
|---|---|
| execution backend | **per-job `opencode serve --port 0 --hostname 127.0.0.1` + HTTP** (ADR-002) |
| prompt | `POST /session/{id}/prompt_async` body (no shell length limits) |
| model | `POST /session` `model: {providerID, id, variant?}` |
| reasoning effort | `variant` — **surfaced as `dcli-opencode --variant`, never `--effort`** (ADR-004) |
| agent | `POST /session` `agent` |
| access / isolation | per-session `permission: PermissionRuleset` — `read-only` denies mutation (edit, webfetch, external_directory) and allows read tools; `workspace` allows everything except `external_directory`; `full` is `* → allow` (explicit named opt-in, never default). See ticket 18. |
| respond (permission) | `Respond(interactionId, decision)` → `POST /permission/{id}/reply` or `/question/{id}/reply`; 404 is benign (interaction already resolved); `reply: always` requires explicit `_automationPolicy` |
| resume | `POST /session` `parentID`, or reuse the recorded session id |
| fork | `POST /session/{id}/fork` |
| working directory | canonical job dir: launch cwd **and** `directory` query param on every request |
| cancel (graceful) | `POST /session/{id}/abort` → `POST /global/dispose` |
| progress | `GET /event` SSE + `GET /session/status` — an unresolvable status is bounded to 12 consecutive polls (60 s at the 5 s interval), then `backend_error` / `class_hint: backend_status_unresolved` and a `failed` job; `unknown` is never a `backend_status` fact |
| permission prompt | `GET /permission` → `POST /permission/{id}/reply {reply: once\|always\|reject}` — polled on an interval during reconciliation; unattended jobs reject with `rejected_unattended` |
| clarifying question | `GET /question` → `POST /question/{id}/reply {answers}` / `/reject` — polled on same interval; unattended rejection with explanatory message |
| auth remediation | `opencode providers login` |
| version detection | `opencode --version`, confirmed by `GET /global/health.version` |
| doctor endpoint shape | `_runEndpointShapeProbes` checks `/global/health` (healthy + version shape), `/permission` (array), `/question` (array), `/session/status` (reachable) |
| doctor live smoke | `dcli-opencode doctor` starts `opencode serve`, sends a trivial read-only request, and reports `ok`, `coverage`, and `live_smoke_timeout_sec`; `--live-smoke-timeout-sec 0` is static-only |
| failure classification | Structured error events parsed via `_classifyBackendError`: `CreditsError` → `quota_or_rate_limit`; unmatched → `null` (no guessing); an unresolvable session status → `backend_status_unresolved` |
| interaction handling | `GET /permission` and `GET /question` polled every `INTERACTION_POLL_MS` (2 s) independently of SSE; unattended interactions rejected with `reply: reject` and explanatory message, emitted as `backend_error` with `class_hint: permission_or_sandbox` |
| structured output | **unavailable** — broken in 1.18.7 (study §8, ADR-006) |
| native worktree | `/experimental/worktree` — namespaced extension, diagnostics only |
| native diff/apply | `/vcs/diff`, `/vcs/apply`, `/session/{id}/diff` — extension, diagnostics only |

**`dcli cancel <job-id>` reaches a foreground `run`/`resume` too.** The running
attempt watches the same `cancel.request` file the detached worker watches, so
a foreground job and a backgrounded one both end `cancelled`.

## dcli wrapper cleanup

The wrapper command is:

```text
dcli-opencode cleanup [--older-than <Nd|Nh>] [--dry-run] [--scrub-session-ids]
```

`N` must be a positive integer; `d` means days and `h` means hours.

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
echo "Add input validation to the user registration form" |
  dcli-opencode submit --mode implement --access workspace --group nightly --hard-timeout-sec $budget
dcli-opencode wait --all --group nightly --timeout-sec $budget --json
dcli-opencode diff <job-id> --stat
dcli-opencode diff <job-id>
dcli-opencode apply --reset-author --message "feat: add input validation" <job-id>
```

## Observed exit codes

| Scenario | Exit |
|---|---:|
| Successful run with final text | `0` |
| Unknown flag | `1` |
| Nonexistent provider/model | `1` |
| Credit/billing failure (reported as HTTP 401 in the event) | `1` |

No granular contract. The wrapper translates to its own codes (spec §7).
