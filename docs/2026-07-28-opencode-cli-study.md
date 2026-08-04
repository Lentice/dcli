# opencode CLI / HTTP surface study

Date: 2026-07-28
Subject: `opencode` **1.18.7** (Bun-built binary at `C:\Users\lenticetsai\.bun\bin\opencode.exe`)
Host: Windows 11 Pro 10.0.26200 x64, PowerShell 7
Purpose: establish the factual basis for the `dcli-opencode` adapter design.

Everything below marked **[observed]** was run live on this host. Anything marked
**[unverified]** was NOT confirmed and must not be relied on until it is. Two independent studies
were run (this agent + a Codex delegate); where they disagreed, the live observation wins and the
disagreement is called out.

---

## 1. Command tree

`opencode --help` **[observed]** — top level:

```
completion   generate shell completion script
acp          start ACP (Agent Client Protocol) server
mcp          manage MCP servers
[project]    start opencode tui                      [default]
attach <url> attach to a running opencode server
run [message..]  run opencode with a message
debug        debugging and troubleshooting tools
providers    manage AI providers and credentials     [alias: auth]
agent        manage agents
upgrade [target]
uninstall
serve        starts a headless opencode server
web          start opencode server and open web interface
models [provider]
stats
export [sessionID]
import <file>
github       manage GitHub agent
pr <number>
session      manage sessions
plugin <module>                                      [alias: plug]
db           database tools
```

Global options **[observed]**: `--print-logs`, `--log-level DEBUG|INFO|WARN|ERROR`, `--pure`
(run without external plugins), `--port` (default `0`), `--hostname` (default `127.0.0.1`),
`--mdns`, `--mdns-domain`, `--cors`, `-m/--model provider/model`, `-c/--continue`,
`-s/--session <id>`, `--fork`, `--prompt`, `--agent`, `--auto`, `--mini`, `--no-replay`,
`--replay-limit`.

### Second level **[observed]**

`run [message..]` — `--command`, `-c/--continue`, `-s/--session`, `--fork`, `--share`,
`-m/--model`, `--agent`, `--format default|json`, `-f/--file <array>`, `--title`,
`--attach <url>`, `-p/--password`, `-u/--username`, `--dir`, `--port`, `--variant`,
`--thinking`, `-i/--interactive`, `--auto`.

`serve` — `--port` (0), `--hostname` (127.0.0.1), `--mdns`, `--mdns-domain`, `--cors`.
`acp` — same plus `--cwd` (defaults to the invocation directory).
`web` — same as `serve`.
`attach <url>` — `--dir`, `-c`, `-s`, `--fork`, `-p`, `-u`, `--mini`, `--no-replay`, `--replay-limit`.
`session` — `list` (`-n/--max-count`, `--format table|json`), `delete <sessionID>`.
`export [sessionID]` — `--sanitize` (redact sensitive transcript and file data).
`import <file>` — file path or share URL.
`agent` — `create` (`--path`, `--description`, `--mode all|primary|subagent`,
`--permissions/--tools`, `-m/--model`), `list`.
`models [provider]` — `--verbose` (includes cost metadata), `--refresh` (refresh from models.dev).
`stats` — `--days`, `--tools`, `--models`, `--project`.
`providers` — `list|ls`, `login [url]` (`-p/--provider`, `-m/--method`), `logout [provider]`.
`mcp` — `add [name]` (`--url`, `--env KEY=VALUE`, `--header KEY=VALUE`), `list|ls`,
`auth [name]`, `logout [name]`, `debug <name>`.
`plugin <module>` — `-g/--global`, `-f/--force`.
`db [query]` — `--format json|tsv`; `db path`.
`github` — `install`, `run` (`--event`, `--token`).
`pr <number>` — fetch/checkout a GitHub PR branch then run opencode.

`debug` subcommands **[observed]**: `config`, `lsp`, `rg`, `file`, `scrap` (list known projects),
`skill`, `snapshot` (`track` / `patch <hash>` / `diff <hash>`), `startup`, `agent <name>`,
`v2`, `info`, `paths`, `wait` (wait indefinitely — a deliberate hang, useful as a test fixture).

`--permissions` available values **[observed]**, from `agent create --help`:
`bash, read, edit, glob, grep, webfetch, task, todowrite, websearch, lsp, skill`.

### Available `--permissions` note

`agent create --permissions` is a coarse allow-list. It is NOT the same mechanism as the
per-session `PermissionRuleset` in §5, which is finer-grained (`permission` + `pattern` + action)
and is the one the adapter should use.

---

## 2. State on disk **[observed]**

`opencode debug paths`:

```
home    C:\Users\lenticetsai
data    C:\Users\lenticetsai\.local\share\opencode
bin     C:\Users\lenticetsai\.cache\opencode\bin
log     C:\Users\lenticetsai\.local\share\opencode\log
repos   C:\Users\lenticetsai\.local\share\opencode\repos
cache   C:\Users\lenticetsai\.cache\opencode
config  C:\Users\lenticetsai\.config\opencode
state   C:\Users\lenticetsai\.local\state\opencode
tmp     %LOCALAPPDATA%\Temp\opencode
```

`opencode debug info` → `opencode version: 1.18.7`, `os: Windows_NT 10.0.26200 x64`, plugins list.
`opencode db path` → `...\.local\share\opencode\opencode.db` (SQLite; tables include `project`,
`session`, `message`, `part`, `permission`, `todo`, `workspace`, `event`).

**Rule:** the SQLite DB is an opencode implementation detail and contains credentials/transcripts.
`dcli-opencode` must never read it on a normal path. `doctor --deep` may run narrow read-only queries
via `opencode db "<SQL>" --format json` for forensics, with redaction.

---

## 3. `session list --format json` **[observed]**

```json
[
  {
    "id": "ses_058dcef55ffe7FOY2l7lq2rzGP",
    "title": "Implement GitHub issue #32 ccodex",
    "updated": 1785216338058,
    "created": 1785215520938,
    "projectId": "bfaf8a5bcc60ba23694623bfb7163f0b243c2cab",
    "directory": "D:\\Documents\\GitHub\\ccodex"
  }
]
```

`created`/`updated` are epoch milliseconds.

`opencode export <sessionID>` **[unverified]** — the Codex study observed it failing to return
within ~34s on this host and produced no output. Do not depend on `export` for job completion.

---

## 4. `run --format json` event stream **[observed]**

NDJSON on stdout, one JSON object per line. Envelope: `{type, timestamp, sessionID, part}`.
Observed `type` values: `step_start`, `tool_use`, `text`, `step_finish`, `error`.

Success (`opencode run --format json --model opencode-go/deepseek-v4-flash --auto "Reply with exactly: PONG"`,
exit `0`, 3 lines):

```json
{"type":"step_start","timestamp":1785226103906,"sessionID":"ses_0583c13e6ffedjsVSHrdAEIC0n","part":{"id":"prt_...","messageID":"msg_fa7c3f0710019AsBJDsx327Nd6","sessionID":"ses_...","snapshot":"f9edf04e705154c4c1859095796742b91b0c9c21","type":"step-start"}}
{"type":"text","timestamp":1785226104623,"sessionID":"ses_...","part":{"id":"prt_...","messageID":"msg_...","sessionID":"ses_...","type":"text","text":"PONG","time":{"start":1785226104577,"end":1785226104618}}}
{"type":"step_finish","timestamp":1785226107590,"sessionID":"ses_...","part":{"id":"prt_...","reason":"stop","snapshot":"f9edf04e...","messageID":"msg_...","sessionID":"ses_...","type":"step-finish","tokens":{"total":19946,"input":19931,"output":3,"reasoning":12,"cache":{"write":0,"read":0}},"cost":0.00279454}}
```

Note the top-level `type` uses **underscores** (`step_start`) while `part.type` uses **hyphens**
(`step-start`). Both appear in the same object. Parsers must not assume one form.

Tool call **[observed]** — `tool_use.part`:

```json
{"type":"tool","tool":"bash","callID":"call_00_PkbJG9g8cbtKfAxD5VeV6144",
 "state":{"status":"completed","input":{"command":"git rev-parse --abbrev-ref HEAD"},
          "output":"master\n","metadata":{"output":"master\n","exit":0,"truncated":false},
          "title":"git rev-parse --abbrev-ref HEAD","time":{"start":...,"end":...}},
 "id":"prt_...","sessionID":"ses_...","messageID":"msg_..."}
```

A multi-step turn emits `step_start, tool_use, step_finish(reason="tool-calls")` then
`step_start, text, step_finish(reason="stop")` **[observed]**. So `step_finish` alone is NOT
completion evidence — only `reason == "stop"` is, and only for the final assistant message.

Error event **[observed]** (opencode Zen credit exhaustion), process exit `1`:

```json
{"type":"error","timestamp":1785225663014,"sessionID":"ses_058424e82ffewMbbne4x34FCeU",
 "error":{"name":"APIError","data":{
   "message":"Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_.../billing",
   "statusCode":401,"isRetryable":false,
   "responseHeaders":{"cf-ray":"...","content-type":"text/plain;charset=UTF-8","server":"cloudflare"},
   "responseBody":"{\"type\":\"error\",\"error\":{\"type\":\"CreditsError\",\"message\":\"Insufficient balance...\"}}",
   "metadata":{"url":"https://opencode.ai/zen/v1/responses"}}}}
```

Note this is a **billing/credit** failure reported as HTTP **401**. Classifying `401` as `auth`
would be wrong here. The `responseBody.error.type` (`CreditsError`) is the discriminator, not the
status code. This is a concrete argument against bare-status-code classification.

The Codex study **[observed]** a nonexistent model producing
`{"type":"error","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_53303ea6"}}}`
with exit `1` — i.e. error payloads can be entirely generic.

### Exit codes **[observed]**

| Scenario | Exit |
|---|---:|
| Successful run with final text | `0` |
| Unknown flag (help dumped to stdout) | `1` |
| Nonexistent provider/model | `1` |
| Credit/billing failure (401 in event) | `1` |

opencode has no granular exit-code contract. `dcli-opencode` must define its own (see design spec).

### Encoding

Captured assistant text contained mojibake (`??`) when read through a default PowerShell pipeline.
Read child stdout as **UTF-8 explicitly**; never rely on the console code page.

---

## 5. THE CRITICAL FINDING: headless `run` hangs forever on an `ask` permission

**[observed]** The local `build` agent resolves `permission: "*" → allow` but
`external_directory → ask` (plus `doom_loop → ask`). Given:

```powershell
opencode run --format json --model opencode-go/deepseek-v4-flash `
  "Read the file <path outside cwd>\outside.txt and tell me its contents."
```

Result: **still running after 120 s with ZERO bytes on stdout** — no event, no prompt marker, no
diagnostic. Killed by the harness. The identical prompt targeting a path *inside* cwd completed in
~30 s.

Consequences, and they are severe:

1. An `ask` permission is externally **indistinguishable from a slow model turn**. The only
   detection mechanism on the CLI path is a timeout.
2. The CLI path can never **answer** the prompt — the run is unrecoverable, and whatever partial
   work happened is lost.
3. The only CLI-level mitigation is the process-global `--auto`, which opencode's own help labels
   `(dangerous!)`. There is no CLI flag for scoped, per-job permission policy.

A wrapper whose headline promise is "never hangs" cannot be built on the CLI path alone. This
single observation is what reverses the backend decision (see ADR-002).

---

## 6. `opencode serve` — the HTTP surface **[observed]**

```powershell
opencode serve --port 47311 --hostname 127.0.0.1
```

Healthy in ~2 s. Stdout:

```
Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
opencode server listening on http://127.0.0.1:47311
```

`GET /doc` returns OpenAPI **3.1.0**, `info.title: "opencode"`, **162 paths**. The relevant subset:

### Lifecycle / health
| Method | Path | Notes |
|---|---|---|
| GET | `/global/health` | `{healthy: true, version: "1.18.7"}` |
| GET | `/event`, `/global/event` | SSE event stream |
| POST | `/global/dispose`, `/instance/dispose` | graceful shutdown |

### Sessions
| Method | Path | Notes |
|---|---|---|
| GET,POST | `/session` | create/list |
| GET,DELETE,PATCH | `/session/{id}` | |
| GET | `/session/status` | map of id → `idle` / `busy` / `retry{attempt,message,next,action{reason,provider,title,message,label,link}}` — **lists only sessions with work in flight**, see below |
| GET,POST | `/session/{id}/message` | POST is **synchronous** for a whole turn |
| POST | `/session/{id}/prompt_async` | **204**, fire-and-forget |
| POST | `/session/{id}/abort`, `/interrupt` | |
| POST | `/session/{id}/fork`, `/summarize`, `/init`, `/command`, `/shell` |  |
| GET | `/session/{id}/diff` | `SnapshotFileDiff[]` |
| POST | `/session/{id}/revert`, `/unrevert` | |

**`/session/status` omits finished sessions entirely [verified live, 1.18.10].** Polled across one
turn it returned `{"ses_…":{"type":"busy"}}` while the turn ran and then `{}` — not an `idle` entry —
once it was over. So *absent from the map* is the completion signal, and reading absence as "unknown"
means a completion is never observed: a turn that failed 5 s in (a 403 `RegionError` from the provider)
was polled for the whole hard-timeout budget and reported as `timed_out` with zero bytes. Absence is
only meaningful after the prompt has been accepted, hence the registration grace period in the adapter.

**Amendment 2026-08-04 (ticket 81) — an unresolvable status is bounded, never progress.** Absence is
handled above, but a status the parse *cannot* resolve at all (a non-object body, an unexpected shape, or
a poll that keeps failing) still yielded `unknown` and the loop treated it as "still working" — an
unbounded wait, invariant #3. Now: `unknown` is not emitted as a `backend_status` fact (that fact's state
enum is `busy|idle|retrying`, so it never was legal), consecutive unresolved polls are bounded to
`UNRESOLVED_STATUS_LIMIT_MS / POLL_INTERVAL_MS` (12 at the defaults, minimum 2), and on exhaustion the
adapter emits `backend_error` with `class_hint: backend_status_unresolved` so the job goes terminal as
`failed` naming the ambiguity — never `done`, never a silent empty result. A failing poll also no longer
leaves the previous status cache in place: it records `unknown`, because leaving it looked like "never
polled" and broke the reconnect loop out, reporting a partial turn as clean.

**A failed turn is a normal message carrying `info.error` [verified live].** There is no separate
failure event once the SSE stream has closed; `GET /session/{id}/message` is the only place the error
is visible, as `info.error.data.{message,statusCode}`. Nothing else reports it, so a turn that the
provider refused otherwise looks like a successful turn with no text.

`POST /session` body **[observed]**:

```json
{ "parentID": "ses_...", "title": "...", "agent": "build",
  "model": { "providerID": "...", "id": "...", "variant": "..." },
  "metadata": {}, "permission": [ /* PermissionRuleset */ ], "workspaceID": "wrk_..." }
```

### Permissions and questions — the decisive endpoints
| Method | Path | Contract |
|---|---|---|
| GET | `/permission` | `PermissionRequest[]` = `{id: "per_...", sessionID, permission, patterns[], metadata, always[], tool{messageID, callID}}` |
| POST | `/permission/{requestID}/reply` | body `{reply: "once"\|"always"\|"reject", message?}` → bool; 404 `PermissionNotFoundError` |
| GET | `/question` | `QuestionRequest[]` = `{id: "que_...", sessionID, questions[], tool}` |
| POST | `/question/{requestID}/reply` | body `{answers: QuestionAnswer[]}` ("answers in order of questions, each an array of selected labels") |
| POST | `/question/{requestID}/reject` | |
| POST | `/session/{id}/permissions/{permissionID}` | per-session persistent grant |

Both accept optional `directory` and `workspace` query parameters.

### Worktrees and VCS
| Method | Path | Contract |
|---|---|---|
| GET,POST,DELETE | `/experimental/worktree` | `Worktree = {name, branch?, directory}`; create body `{name?, startCommand?}`; delete body `{directory}` |
| POST | `/experimental/worktree/reset` | |
| GET | `/vcs`, `/vcs/status`, `/vcs/diff`, `/vcs/diff/raw` | `VcsFileDiff = {file, patch?, additions, deletions, status: added\|deleted\|modified}` |
| POST | `/vcs/apply` | body `{patch}` → `{applied: bool}` |

### Other useful
`GET /agent`, `GET /skill`, `GET /command`, `GET /lsp`, `GET /provider`, `GET /project`,
`GET /project/current`, `GET /path`, `GET /find`, `GET /file`, `GET,PATCH /config`,
`GET /experimental/capabilities`, `GET /experimental/tool/ids`, `GET,POST /mcp`,
plus a parallel `/api/**` v2 surface and `/tui/**` control endpoints.

Event component names in the schema include `EventPermissionAsked`, `EventPermissionReplied`,
`EventQuestionAsked`, `EventQuestionReplied`, `EventQuestionRejected`, `EventSessionIdle`,
`EventSessionError`, `EventSessionStatus`, `EventSessionDiff`, `EventFileEdited`,
`EventWorktreeReady`, `EventWorktreeFailed`, `EventInstallationUpdated`.

---

## 7. Per-session permission ruleset defeats the §5 hang **[observed]**

```
PermissionRuleset = PermissionRule[]
PermissionRule    = { permission: string, pattern: string, action: "allow"|"deny"|"ask" }
```

Test: created a session with `permission: [{permission:"*", pattern:"*", action:"allow"}]`, then
sent **the exact prompt that hung indefinitely in §5**.

Result: completed in **88 s**, returned `SECRETVALUE=42` (the out-of-tree file's contents),
`parts: step-start, reasoning, text, step-finish`. `GET /permission` was empty throughout.

So a per-session ruleset **overrides the config's `ask`**, per job, with no global `--auto`.
`deny` is equally expressible. This is the mechanism that makes a no-hang guarantee achievable.

**Caveat, and it matters:** this proves *one* wildcard `allow` rule overrides *one* observed `ask`.
It does NOT prove rule precedence, ordering, pattern-matching semantics, or `deny` behavior across
tools and versions. Those need contract tests before fine-grained rulesets are trusted. Broad
`allow` must be an explicit opt-in mode, never a default.

---

## 8. Structured output is BROKEN in 1.18.7 **[observed]**

`POST /session/{id}/message` accepts `format` (`OutputFormat = OutputFormatText |
OutputFormatJsonSchema`), where `OutputFormatJsonSchema = {type: "json_schema", schema, retryCount?}`.
The `JSONSchema` component is unconstrained (`{"type": "object"}`).

Observed with `opencode-go/deepseek-v4-flash` and a small object schema:

1. The POST returned **`parts: []`** — no text, no error part, nothing usable.
2. Afterwards `GET /session/{id}/message` **permanently 400s** for that session:
   `Expected OutputFormatJsonSchema, got {"type":"json_schema","schema":{...},"retryCount":2} at [0]["info"]["format"]`
   — note the server injected `retryCount: 2` on write and then rejected its own stored value on read.
3. A sibling session created without `format` reads back fine.

Cause not isolated — it may be model-side (this provider may not support structured outputs) rather
than purely a server bug. Either way:

**Do not use native structured output.** Request plain text, and do wrapper-side JSON extraction +
validation. Do not "fall back" to text within the same session — the session is already corrupted.

---

## 9. `acp` — Agent Client Protocol

`opencode acp` starts a JSON-RPC-over-stdio ACP server, aimed at editors/interactive clients.
**Not recommended** as an adapter backend: it adds a second stateful protocol and subprocess
lifecycle while the HTTP surface already exposes everything needed. Revisit only if it ever offers
permission/cancellation semantics HTTP lacks.

---

## 10. Models available on this host **[observed]**

Providers with credentials: `opencode` (Zen — **credit-exhausted**, see §4), `opencode-go`, `nvidia`.
`opencode models` lists ~40 `opencode/*` entries (claude-*, gpt-5.x, gemini-3.x, glm-5.x,
deepseek-v4-*), 16 `opencode-go/*`, and a large `nvidia/*` catalogue.

Model used for all live probes: **`opencode-go/deepseek-v4-flash`** (cheap, working).
`opencode/*` (Zen) returns the §4 `CreditsError` on this host.

`--variant` is documented as "provider-specific reasoning effort, e.g. high, max, minimal" — an
**unbounded string**, deliberately not an enum. This is why it must not be mapped onto a shared
`--effort` flag (see ADR-004).

---

## 11. Confirmed-unverified list

Do not build behavior on these until they are tested:

1. Rule precedence / ordering / pattern semantics of `PermissionRuleset`, and `deny` behavior (§7).
2. Whether `--port 0` reliably reports the bound port, and where.
3. Basic-auth behavior with `OPENCODE_SERVER_PASSWORD` / `--password` / `--username` on every endpoint.
4. `directory` / `workspace` query-parameter routing correctness per endpoint.
5. SSE framing, reconnect, replay, and whether events can be missed.
6. Whether `POST /session/{id}/message` can block for an unbounded turn (assume yes).
7. What a permission request looks like on the SSE stream vs `GET /permission` polling.
8. Real auth failure, quota/rate-limit, network outage, and provider-overload payloads.
9. `opencode export` shape and its observed hang on this host.
10. Empty prompt / process exits 0 with no assistant text.
11. Whether `-f/--file` attachments are reliably surfaced to the model as text.
12. Whether `--agent` without `--model` honors the agent's configured model on both CLI and HTTP.
13. Whether external plugins (`context-mode` is active here) alter the event stream; `--pure` behavior.
14. Whether opencode leaves descendants after hard termination.
15. `/experimental/worktree` lifecycle, and `/doc` stability across opencode versions.
16. Whether a wrapper-generated read-only ruleset resists adversarial prompts.

---

## 12. Reproduction commands

```powershell
opencode --version ; opencode --help
foreach ($c in 'run','serve','session','export','import','agent','models','stats','debug',
               'providers','mcp','attach','acp','web','plugin','db','github','pr') {
  opencode $c --help
}
opencode session list --help ; opencode agent create --help ; opencode mcp add --help
opencode debug paths ; opencode debug info ; opencode db path
opencode session list -n 2 --format json
opencode models

# NDJSON event stream
opencode run --format json --model opencode-go/deepseek-v4-flash --auto "Reply with exactly: PONG"

# tool_use event
opencode run --format json --model opencode-go/deepseek-v4-flash --auto `
  "Run the bash command 'git rev-parse --abbrev-ref HEAD' and report only its output."

# THE HANG (bound it, or it never returns)
opencode run --format json --model opencode-go/deepseek-v4-flash `
  "Read the file <outside-cwd>\outside.txt and tell me its contents."

# HTTP surface
opencode serve --port 47311 --hostname 127.0.0.1
Invoke-RestMethod http://127.0.0.1:47311/doc | ConvertTo-Json -Depth 40 > openapi.json
Invoke-RestMethod http://127.0.0.1:47311/global/health
Invoke-RestMethod -Method Post http://127.0.0.1:47311/global/dispose
```
