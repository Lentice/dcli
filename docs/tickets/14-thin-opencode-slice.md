# 14 — Thin opencode adapter slice

**Blocked by:** 02, 10
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md) §6 (the two decisive facts),
[reference/cli-opencode.md](../reference/cli-opencode.md),
[study §6–§7](../2026-07-28-opencode-cli-study.md#6-opencode-serve--the-http-surface-observed).

**Build this in parallel with ticket 15.** They are two halves of one proof.

---

## Purpose

`copencode run "say hello"` works against a real opencode install, through the narrowest possible adapter.
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

1. `cli/copencode.js` selects the backend **before argument parsing**, so help and validation are
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

- [ ] `copencode` shim selects the backend before argument parsing.
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
node cli/copencode.js run --hard-timeout-sec 300 --model opencode-go/deepseek-v4-flash "Reply with exactly: PONG"
Get-Process opencode -ErrorAction SilentlyContinue   # must show no survivor from that run
```

## Definition of done

The contract suite passes unmodified, a live `run` returns text, and no server survives.

## Commit message

```
feat(opencode): thin adapter slice proving the contract against a server-backed backend
```

## Notes
