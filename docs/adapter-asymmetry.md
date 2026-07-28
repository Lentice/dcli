# Adapter asymmetry ledger

Every adapter implements the same [`contract suite`](../tests/contract/suite.js) without
backend-specific branching. This document records where the *capabilities* differ — operations a
backend either supports or does not — and the reasons. These are **feature asymmetries**, not
contract violations.

## Contract operations

| Operation | fake | opencode | codex | Notes |
|---|---|---|---|---|
| `GetIdentity` | yes | yes | yes | — |
| `DetectVersion` | yes | yes | yes | — |
| `ProbeCapabilities` | yes | yes | yes | — |
| `DeclareCancelRungs` | yes | yes | yes | — |
| `ValidateRequest` | yes | yes | yes | — |
| `PrepareInvocation` | yes | yes | yes | — |
| `Start` | yes | yes | yes | — |
| `Observe` | yes | yes | yes | — |
| `SendPrompt` | yes | yes | yes | — |
| `Resume` | yes | yes | yes | stub-only in thin slice; not implemented for any backend |
| `Respond` | yes (if capability declared) | no | no | Requires backend HTTP interface for interactive permissions. Neither opencode thin slice nor codex exec mode provides this. |
| `RequestCancel` | yes | yes | yes | Rung count differs (see below) |
| `CollectResult` | yes | yes | yes | — |
| `CollectDiagnostics` | yes | yes | yes | — |
| `Dispose` | yes | yes | yes | — |
| `Recover` | yes | yes | yes | — |
| `LiveSmoke` | yes | yes | yes | — |

## Fact types

| Fact type | fake | opencode | codex | Notes |
|---|---|---|---|---|
| `started` | emitted | emitted | emitted | — |
| `assistant_text` | emitted | emitted | emitted | — |
| `reasoning` | configurable | via server events | via JSONL | codex parses `reasoning` events from NDJSON stream |
| `tool_invoked` | configurable | via server events | via JSONL | — |
| `tool_result` | configurable | via server events | via JSONL | — |
| `interaction_pending` | configurable | via `GET /permission` / `GET /question` (v1, not in thin slice) | never emitted | codex exec has no interactive permission surface |
| `interaction_resolved` | configurable | via permission reply (v1, not in thin slice) | never emitted | — |
| `usage_reported` | configurable | via message response (`tokens` field) | via JSONL `usage` events | — |
| `backend_status` | configurable | emitted (`idle`/`busy`/`retry` from `GET /session/status`) | **never emitted** | codex has no status API; process-alive is the only liveness signal |
| `backend_error` | configurable | via server error responses | via JSONL `error` events | — |
| `process_exited` | configurable | emitted on process exit | emitted on process exit | — |
| `stream_closed` | configurable | via SSE stream closure | via stdout/JSONL drain | — |

## Asymmetries by concern

### `backend_status` fact

| Backend | Support | Reason |
|---|---|---|
| opencode | emitted via `GET /session/status` → `idle`/`busy`/`retry` | The HTTP server exposes a real status endpoint the adapter polls. |
| codex | never emitted | `codex exec` is a one-shot CLI process with no status API. Process-alive is the only liveness signal. The adapter must not fabricate a status. |

### `Respond` (interactive permissions)

| Backend | Support | Reason |
|---|---|---|
| opencode | declared via `extensions.interactive_permissions` capability when the thin slice implements permission polling over HTTP | `GET /permission` + `POST /permission/{id}/reply` exist in the opencode HTTP API. |
| codex | impossible | `codex exec` has no CLI flag for permission approval/rejection (verified against `codex exec --help` in 0.145.0). The sandbox mode (`--sandbox read-only`) is the only access control. |

### Cancel rung count

| Backend | Rungs | Sequence |
|---|---|---|
| opencode | 3 | `session_abort` → `server_dispose` → `hard_kill` |
| codex | 1 | `hard_kill` |

**Why opencode has three:** The HTTP server supports graceful session abort (`POST /session/{id}/abort`) and server disposal (`POST /global/dispose`) before falling back to OS-level process kill. Each rung gives the backend a chance to clean up.

**Why codex has one:** `codex exec` is a single child process with no intermediate cancellation API. The only operation is hard kill of the process tree.

### Graceful abort

| Backend | Support | Mechanism |
|---|---|---|
| opencode | yes | `POST /session/{id}/abort` terminates the model interaction without killing the server. |
| codex | no | No abort API exists for `codex exec`. |

### Structured output (schema-constrained generation)

| Backend | Support | Reason |
|---|---|---|
| opencode | broken (known) | opencode 1.18.7's structured output via `--output-schema` is functionally broken — requesting it makes the session permanently unreadable (study §8). The adapter requests plain text and performs wrapper-side extraction. |
| codex | works | `codex exec` supports `--output-schema` with NDJSON. The adapter uses `--json` natively. |

### Effort / reasoning surface

| Backend | Flag / option | Type |
|---|---|---|
| opencode | `--variant <provider string>` | Unbounded string, passed through to the provider. The adapter rejects `--effort` and `--reasoning-effort` with a clear message pointing to `--variant`. |
| codex | `-c model_reasoning_effort=<level>` | Enum (`none`/`low`/`medium`/`high`/`ultra`), passed via `-c` config. The adapter rejects `--variant` with a clear message pointing to `--effort`. |

### Resume support

All three adapters declare `core.resume: false` in their capabilities. The `Resume()` method exists as a
no-op stub. Resume semantics differ per backend (session resume, fork from artifacts, retry) and are
not implemented in the thin slice.

## Allowable differences that are NOT asymmetries

These are not asymmetries; they are implementation details that the contract intentionally leaves open:

| Difference | Why it is not an asymmetry |
|---|---|
| Process creation mechanism | opencode spawns an HTTP server; codex spawns `codex exec` with stdin. Both produce the same fact stream. |
| Discovery method | opencode scans `bun` global install paths; codex finds `codex-cli` vendor binary. Both produce a valid path string. |
| Temporary file usage | codex writes result to `--output-last-message` file; opencode returns it in the HTTP response. Both produce `CollectResult({text, usage})`. |
| Error source | opencode errors come from HTTP responses; codex errors from stderr/NDJSON. Both produce `backend_error` facts. |

## Rule

When adding a new capability or fact type to any adapter, the shared contract suite in
[`suite.js`](../tests/contract/suite.js) **must** be updated first — before the backend-specific code —
so the suite stays the forcing function for contract design. If the new capability cannot be expressed
in the shared suite without backend branching, that is a finding that the contract abstraction is wrong.
