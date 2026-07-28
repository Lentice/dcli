# Adapter contract

**Version:** `contract_version: 1`
**Status:** accepted
**Supersedes:** nothing (new document)

This document defines the contract between the dcli job engine and every backend adapter.
Adapters implement these operations. The engine depends on them. Both sides agree on the fact
vocabulary, the interaction-outcome enum, and the pre/postconditions stated here.

---

## 1. Adapter identity

```ts
GetIdentity() → { backend: string, adapter_version: string, state_schema_version: number }
```

- `backend` is an opaque adapter ID (`codex`, `opencode`, `claude`, `fake`) — never a vendor name.
- `adapter_version` is semver of this adapter's own code.
- `state_schema_version` is the version of the `backend_state` schema this adapter writes.

---

## 2. Discovery

```ts
DetectVersion() → string
```

Returns the installed backend CLI version string (e.g. `"1.18.7"`). Must not throw; the engine
handles version-incompatible scenarios via `doctor`.

```ts
ProbeCapabilities() → CapabilityManifest
```

Returns the effective capability manifest, computed from the static manifest plus runtime probes.
The engine snapshots this into every job at creation.

```ts
DeclareCancelRungs() → string[]
```

Returns an ordered array of rung names this backend actually supports. The engine walks them in
order. Example: `['session_abort', 'server_dispose', 'hard_kill']` for opencode;
`['hard_kill']` for codex and claude.

**Postcondition:** the array is non-empty. Every string is a non-empty rung identifier.

---

## 3. Request validation

```ts
ValidateRequest(request: object) → void  // throws on rejection
```

Validates the request against this backend's declared capabilities. Must NOT create a job or
write any durable state.

**Precondition:** the request object has already passed engine-level validation.
**Postcondition on rejection:** a typed `Error` with `err.code === 'VALIDATION_FAILED'` is thrown.
No durable state has been written.

---

## 4. Execution lifecycle

### 4.1 Prepare

```ts
PrepareInvocation(attempt, request) → void
```

Writes backend-owned input and configuration artifacts into the attempt directory. Called before
`Start`.

**Precondition:** the attempt directory exists and is writable.
**Postcondition:** any artifacts needed by `Start` are on disk.

### 4.2 Start

```ts
Start(attempt) → ExecutionHandle
```

Begins execution of the backend. Returns a handle the engine can use for correlation.

**Precondition:** `PrepareInvocation` has completed.
**Postcondition:** the backend is running or has begun its startup sequence.

### 4.3 Observe

```ts
Observe(attempt) → AsyncIterable<Fact>
```

Returns an async iterator yielding normalized fact objects (section 7). The iterator:

- MUST yield facts in temporal order.
- MUST NOT contain transport-level objects (HTTP responses, raw NDJSON lines, SSE frames).
- SHOULD yield `backend_status` periodically when the backend is long-running.
- MUST terminate when the backend's output is fully consumed.

**Postcondition:** every yielded value passes `validateFact()` (section 7).

### 4.4 SendPrompt

```ts
SendPrompt(attempt, prompt: string) → void
```

Delivers the prompt to the backend for execution. For CLI adapters this may be a no-op (the
prompt was already provided at invocation). For HTTP adapters this triggers the session to begin
processing.

### 4.5 Resume

```ts
Resume(attempt, kind: string, prompt: string) → void
```

Resumes execution. `kind` is one of `continue_backend_session` or `fork_from_artifacts`.

**Precondition:** `kind` is supported per the capability manifest.

---

## 5. Interaction handling

```ts
Respond(interactionId: string, decision: object) → void  // OPTIONAL
```

Responds to a pending permission or question interaction. This operation is gated by the
capability manifest: if `extensions.interactive_permissions.supported` is not true, calling
`Respond` MUST throw.

**Precondition:** the capability declares `interactive_permissions.supported`.
**Postcondition:** the response has been delivered to the backend or queued for delivery.

---

## 6. Cancellation

```ts
RequestCancel(attempt, rung: string) → { success: boolean, error?: string }
```

Performs one declared cancellation rung. The engine walks the ladder declared by
`DeclareCancelRungs()` and calls this once per rung until one succeeds.

**Postcondition per adapter (stated here because it varies):**

| Adapter | What is guaranteed stopped when `success: true` is returned |
|---|---|
| codex | The child process tree is being terminated |
| opencode | A graceful session abort has been issued |
| claude | The child process tree is being terminated |
| fake | `cancelled` flag is set; `Observe` will stop at the next yield point |

**Postcondition for all adapters:** The operation is safe to call on an already-cancelled
attempt. A rung that is not in the declared list may be rejected or ignored.

---

## 7. Result collection

```ts
CollectResult(attempt) → { text: string, usage: UsageInfo, backend_session_id: string|null }
```

Collects the final assistant text, token usage, and backend session identity. Fields are present
(never omitted) but may be `null` or `0` when the data is unavailable.

```ts
CollectDiagnostics(attempt) → DiagnosticBundle
```

Returns a redacted diagnostic bundle for `debug` and `doctor`. Carries its own `schema_version`.

```ts
{
  "schema_version": 1,
  "backend": "fake",
  "facts_emitted": 5,
  "exit_code": 0,
  // … adapter-specific safe-for-diagnostic fields
}
```

---

## 8. Teardown

```ts
Dispose(attempt) → void
```

Releases any transient resources held by the adapter for this attempt: file handles, server
connections, temporary artifacts.

**Postcondition:** Safe to call twice. After `Dispose`, the adapter holds no resources for this
attempt.

```ts
Recover(attempt) → { state: string }
```

Inspects durable evidence after a controller crash and returns the inferred attempt state.

**Postcondition:** The returned state MUST be one of `done`, `failed`, `timed_out`,
`cancelled`, or `interrupted`. It MUST NEVER be `running` or `created`. The attempt is
permanently no longer `running`.

---

## 7. Fact vocabulary

Every fact has a string `type` field and type-specific fields. This set is **closed**: adding a
fact type requires a contract-version change. An adapter emits a subset; the engine tolerates
missing fact types.

### Fact table

| `type` | Required fields | Optional fields | Emitted by |
|---|---|---|---|
| `started` | — | `backend_pid`, `backend_session_id` | all |
| `assistant_text` | `message_id`, `text` | — | all |
| `reasoning` | `message_id` | — | opencode, claude |
| `tool_invoked` | `call_id`, `tool`, `summary` | — | all |
| `tool_result` | `call_id`, `ok`, `summary` | — | all |
| `interaction_pending` | `interaction_id`, `kind` (`permission`|`question`), `detail` | — | opencode |
| `interaction_resolved` | `interaction_id`, `outcome` | — | opencode |
| `usage_reported` | `tokens` (`{input, output, total}`) | `cost` | all |
| `backend_status` | `state` (`busy`|`idle`|`retrying`) | `attempt`, `next_at` | opencode |
| `backend_error` | — | `class_hint`, `structured_payload` | all |
| `process_exited` | `code` | — | all |
| `stream_closed` | `reason` | — | all |

### Validation

Every fact object yielded by `Observe` passes `validateFact()`.

```js
validateFact({ type: 'unknown' })           // throws — unknown fact type
validateFact({ type: 'process_exited' })    // throws — missing 'code'
validateFact({ type: 'process_exited', code: 0 })  // OK
```

### Rules

- **No fact means "the job is done".** `process_exited` and an idle `backend_status` are evidence,
  not a terminal declaration. The engine owns the terminal-state reducer.
- Asymmetry is expected: codex will never emit `backend_status`. The engine must tolerate
  missing fact types.

---

## 8. Interaction outcomes — shared enum

Defined in `core/interaction-outcome.js`. Every `interaction_resolved` fact carries one of these
as its `outcome` field.

| Value | Meaning |
|---|---|
| `pre_authorized` | The job's declared policy allowed it; nothing was asked. |
| `denied_by_policy` | The job's declared policy refused it; the backend was told no. |
| `awaiting_authorized_responder` | Something must answer, and a responder exists (attended use or automation policy). |
| `rejected_unattended` | Something must answer; nothing is authorized to. The job fails as blocked. |

---

## 9. Lifecycle `--json` envelope

Commands that output `--json` use a shared envelope with `schema_version`. Fields may be `null`,
never omitted.

```json
{
  "schema_version": 1,
  "adapter": {
    "backend": "codex",
    "version": "1.0.0",
    "state_schema_version": 1
  },
  "data": { }
}
```

The `data` field contains the command-specific payload. The envelope fields documented in
`status.json` (design spec §5) follow the same `schema_version` / never-omit-nullable rule.

---

## 10. Adapter interface boundary

The engine imports adapters as modules. Each adapter exports a class whose prototype implements
every operation in this contract. No operation:

- Mentions HTTP, sessions-as-lifecycle, raw streams, or process internals in its signature.
- Returns a transport-level object (HTTP response, NDJSON line, SSE frame).
- Declares terminality — there is no method like `isDone()` or `setTerminal()`. Adapters emit
  facts; the engine decides state.
