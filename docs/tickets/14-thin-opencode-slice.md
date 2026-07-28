# 14 — Thin opencode adapter slice

**Blocked by:** 02, 10
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md) §6 (the two decisive facts),
[reference/cli-opencode.md](../reference/cli-opencode.md),
[study §6–§7](../2026-07-28-opencode-cli-study.md#6-opencode-serve--the-http-surface-observed).

**Build this in parallel with ticket 15.** They are two halves of one proof.

---

## Purpose

`dcli-opencode run "say hello"` works against a real opencode install, through the narrowest possible adapter.
No permission handling, no interactions, no worktrees — just prove a real server-backed backend satisfies the
contract.

## Why it matters

This is the first real adapter. Its job is not to be complete; its job is to be **honest about what the
contract needs**, so ticket 15 can prove the same contract works for a backend with no server at all.

Everything you defer here has a home: server hardening → ticket 17, sessions and permissions → 18, event
reconciliation → 19, interactions → 20.

## Facts you need (verified)

- `opencode serve --port 0 --hostname 127.0.0.1` came up healthy in ~2 s. Startup stdout:
  ```
  Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
  opencode server listening on http://127.0.0.1:47311
  ```
- `GET /global/health` → `{ "healthy": true, "version": "1.18.7" }`
- `POST /session` body: `{ title?, agent?, model: { providerID, id, variant? }, permission?, metadata? }`
  → a `Session` with an `id` like `ses_...`
- `POST /session/{id}/message` body `{ parts: [{ type: "text", text }] }` → `{ info, parts }`.
  **Synchronous — it blocks for the whole model turn.** Acceptable for this thin slice only; ticket 19
  replaces it with `prompt_async`.
- Text comes back as a part with `type: "text"` and a `text` field.
- `POST /global/dispose` shuts the server down.
- A working model on the study host: `opencode-go/deepseek-v4-flash`. The `opencode/*` (Zen) provider was
  credit-exhausted and returns an error event.

## Design

1. `cli/dcli-opencode.js` selects the backend **before argument parsing**, so help and validation are
   backend-specific from the first token.
2. `adapters/opencode/adapter.js` implements the contract minimally:
   - `Start`: spawn `opencode serve --port 0 --hostname 127.0.0.1` under containment (ticket 06), with a
     random password in `OPENCODE_SERVER_PASSWORD` in the **environment**.
   - Obtain the bound port by the most machine-readable channel available; then **confirm with
     `GET /global/health`** regardless. If you end up parsing startup output, record that as a known weakness
     for ticket 17 — do not pretend it is a contract.
   - Create a session, send the prompt, take the final text part, emit facts, dispose the server.
   - `DeclareCancelRungs()` → `['session_abort', 'server_dispose', 'hard_kill']`.
3. Emit only closed-set facts: `started`, `assistant_text`, `usage_reported`, `process_exited`,
   `backend_error`, `stream_closed`. **Do not** emit anything session-shaped.
4. Detect version and gate it. An out-of-range opencode fails closed with the supported range.
5. Capture and drain server stdout/stderr for the server's whole lifetime (ticket 07).

## Pitfalls

- The password goes in the **environment**. Never on a command line, never in a log.
- `--port 0` behavior is **unverified**. Do not assume the port appears where you expect it.
- Do not let the synchronous message call sit without an `AbortController` deadline — it can block for an
  entire model turn.
- Do not add a `Respond` implementation here. Interactions are ticket 20, and adding them early tempts the
  contract toward HTTP.
- Verify the server is **gone** after the job terminalizes. A leaked server is a leaked port, a leaked
  process, and a leaked secret.

## Checklist

- [ ] `dcli-opencode` shim selects the backend before argument parsing.
- [ ] Adapter starts a per-job server under containment, with the password passed via environment only.
- [ ] The bound port is obtained and then **confirmed** with `GET /global/health`.
- [ ] If startup-output parsing was necessary, it is recorded in Notes as a ticket-17 weakness.
- [ ] Adapter creates a session, sends the prompt, and collects the final assistant text.
- [ ] Adapter emits only closed-set fact types; a test asserts no unknown fact type escapes.
- [ ] Adapter does **not** decide terminality.
- [ ] `DeclareCancelRungs()` returns opencode's three real rungs.
- [ ] **The contract test suite passes against this adapter, unmodified.**
- [ ] Version detection and gating work; an out-of-range version fails closed naming the range.
- [ ] Server stdout/stderr is captured and drained for the whole server lifetime.
- [ ] The server process is verifiably gone after a terminal job — asserted, not assumed.
- [ ] A live smoke test exists, opt-in, and is **skipped with a clear message** when opencode is absent.
- [ ] The live smoke uses a cheap working model and carries an execution budget.

## How to verify

```powershell
node tests/run-tests.js --suite full
node cli/dcli-opencode.js run --hard-timeout-sec 300 --model opencode-go/deepseek-v4-flash "Reply with exactly: PONG"
Get-Process opencode -ErrorAction SilentlyContinue   # must show no survivor from that run
```

## Definition of done

The contract suite passes unmodified, a live `run` returns text, and no server survives.

## Commit message

```
feat(opencode): thin adapter slice proving the contract against a server-backed backend
```

## Notes

### Discovery: opencode version mismatch
The study documents opencode 1.18.7 as the tested version. The installed version on this host is
**1.18.8** (`opencode --version`). The adapter declares `supported_version_range: { min: '1.18.0', max: '1.19.0' }`
which covers both.

### Known weakness: startup-output port parsing (→ ticket 17)
`--port 0` causes opencode to allocate an ephemeral port. The only channel to obtain it is
startup stdout: `opencode server listening on http://127.0.0.1:<port>`. Parsing human logs is
not a contract. The adapter confirms the port with `GET /global/health`, but the initial
discovery is fragile. This is the expected home for ticket 17 (server hardening).

### Discovery: HTTP client missing Basic auth (fixed in same commit)
The adapter's `httpRequest()` helper (and therefore `httpGet`/`httpPost`) never sent any
`Authorization` header, even though `Start()` sets `OPENCODE_SERVER_PASSWORD` in the server's
environment. When the env var is present, opencode requires Basic auth on every endpoint
(confirmed: `GET /global/health` returned 401 without credentials). Fixed by passing the
generated password through the `opts` parameter to every HTTP call site. Confirms
study §11.3 open question.

### Bugfix: hardTimeoutSec enforcement and server leak prevention (ticket 14/10)
`core/commands/run.js`'s `executeRun()` previously accepted `hardTimeoutSec` and stored it in
job metadata via `store.createJob()` but never used it to bound the actual adapter operations.
Three code paths ran unbounded:
- `adapter.Start(attempt)`
- `adapter.SendPrompt(attempt, prompt)`
- `for await (const fact of adapter.Observe(attempt))`

The only internal bound was the opencode adapter's `MESSAGE_TIMEOUT_MS` (600000ms / 10 min).
When that HTTP-level timeout failed to fire (observed: the command hung indefinitely past the
stated 60-second hard timeout), the job became a permanent hang, and the server process leaked
because nothing called `RequestCancel` or `Dispose` — the process tree survived as an orphan.

**Fix applied:**
1. Added a hard timeout timer in `executeRun()` that fires after `hardTimeoutSec * 1000`.
   On fire: calls `adapter.RequestCancel()` through all declared rungs (session_abort,
   server_dispose, hard_kill), sets `hardTimedOut = true`.
2. After `Start()`, after `SendPrompt()`, and at each iteration of the `Observe()` loop,
   checks `hardTimedOut`. If true, journals `attempt_state_changed → timed_out` with
   `failure_reason: 'hard_timeout'`, releases the admission slot, and returns.
3. A post-loop `hardTimedOut` check catches the case where the Observe generator ended
   mid-cancellation (interrupted by `RequestCancel`).
4. Added a wall-clock safety net to `adapters/opencode/adapter.js`'s `httpRequest()`:
   a `setTimeout` at effectiveTimeout + 5s that destroys the request and rejects, guarding
   against scenarios where the socket-level timeout doesn't fire (e.g. slow data trickle).
   Also fixed a potential double-rejection by routing all resolve/reject through a
   `settled` flag.
5. Added regression test `tests/adapters/opencode/hard-timeout.test.js` (gated on
   `DCLI_OPENCODE_LIVE_SMOKE` and opencode on PATH).

**Manual verification results:**
- `node cli/dcli-opencode.js run --hard-timeout-sec 10 --model opencode-go/deepseek-v4-flash --json "Reply with exactly: PONG"`
  → returned within ~15s with `{"state":"timed_out","failure_reason":"hard_timeout"}`.
- `node cli/dcli-opencode.js run --hard-timeout-sec 60 --model opencode-go/deepseek-v4-flash --json "Reply with exactly: PONG"`
  → also returned within ~70s with `timed_out` (model inference exceeds 60s on this host).
- Neither command hung. Both produced a clean JSON envelope. No leaked server processes
  with the spawn signature `opencode serve --port 0 --hostname 127.0.0.1` were left alive
  (after cleaning up 2 pre-existing orphans from prior runs, PIDs 45904 and 42128).

### Discovery: opencode 1.18.8 `--port 0` resolves to fixed default 4096, not ephemeral (→ ticket 17)

The study (§11.2) and earlier Notes entries assumed `--port 0` allocated an ephemeral port.
**This is false for opencode 1.18.8.** Verified by invoking both the bun shim
(`C:\Users\lenticetsai\.bun\bin\opencode.exe`) and the real binary
(`C:\Users\lenticetsai\.bun\install\global\node_modules\opencode-ai\bin\opencode.exe`) directly
with `serve --port 0 --hostname 127.0.0.1`. Both bound to fixed port 4096. `opencode serve --help`
confirms `--port [number] [default: 0]`, meaning 0 is opencode's own sentinel for "use the
built-in default (4096)", not "request an ephemeral port from the OS".

**Consequence for ticket 17 (per-job server lifecycle):** If every concurrent job's server binds
4096, port collision is guaranteed for any second simultaneous job on the same machine. This is
not solvable by a different `--port` interpretation — the adapter must either:
- Choose a unique port (parse `--port 4096+N` or use a reservation protocol), or
- Adopt a different server-per-job topology.

No fix is attempted here; documented as a hard constraint for ticket 17.

**Correction applied to** `docs/2026-07-28-opencode-cli-study.md` §11.2 (removed "ephemeral" from
the unverified-item description).

### Behaviors deferred to later tickets
- Permission handling and `Respond` → tickets 18, 20.
- `POST /session/{id}/message` is synchronous and blocks for the whole model turn → ticket 19
  replaces this with `prompt_async`.
- SSE event stream → ticket 19.
- Server stdout/stderr continuous drain → ticket 07/17.
- Containment through the native helper → ticket 06 (helper exists; not wired into thin slice).
- `capabilities.json` and `compatibility.json` files → not created yet; `ProbeCapabilities()`
  returns an inline manifest for now.
