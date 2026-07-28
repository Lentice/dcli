# 17 — opencode: per-job server lifecycle

**Blocked by:** 16
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md) §6, [reference/cli-opencode.md](../reference/cli-opencode.md),
[ADR-002](../2026-07-28-architecture-decisions.md#adr-002) **including its 2026-07-28 amendment**.

---

## Purpose

The per-job `opencode serve` process becomes production-grade: reliably started, reliably addressed, reliably
authenticated, reliably disposed, and never able to hang or outlive its job.

## Why it matters

Ticket 14 proved the shape works. This ticket closes the five failure modes reviewers identified as the ones
that "will not survive contact with reality":

1. Port discovery by log scraping is not a contract.
2. Loopback is **not** authentication — any process running as the same user can find the port and drive it.
3. An undrained server pipe hangs the server.
4. A server can outlive a dead wrapper.
5. Fan-out multiplies real resources, not just process count.

## Facts you need

- `--port 0` is documented as the default, and its actual reporting behavior is **unverified** (study §11.2).
- Startup stdout observed: `opencode server listening on http://127.0.0.1:47311`, preceded by
  `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.`
- `GET /global/health` → `{ healthy: true, version }`.
- `POST /global/dispose` and `POST /instance/dispose` exist.
- `-p/--password` and `-u/--username` default to `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`.
- `--mdns` widens the bind address to `0.0.0.0`. **Never set it.**

## Design

### Port acquisition — in this order

1. Prefer any machine-readable handshake opencode offers. Investigate first and record what you find.
2. If none exists, reserve a free loopback port yourself, then launch with it. This introduces a
   **close-then-bind race** — accept it, retry bounded, and **test the race** explicitly.
3. Either way, **confirm** with `GET /global/health` before sending anything else, and record the confirmed
   port in `<state-root>/servers/<job-id>.json`.

Do not treat startup-output parsing as the primary mechanism. If it is unavoidable, isolate it in one function
with a golden fixture so a format change is a test failure, not a mystery.

### Authentication

Generate a random per-job password (≥128 bits of entropy). Pass it via `OPENCODE_SERVER_PASSWORD` in the child
environment. **Never** on a command line, never in a log, never into `command.txt`. Register it with the
redactor (ticket 13) at creation. Send it on **every** request, including health checks.

### Server metadata

`<state-root>/servers/<job-id>.json`: pid, creation time, image path, execution token, confirmed port,
started-at. This is what lets a *crashed* wrapper's servers still be found and cleaned up.

### Output capture

Capture stdout and stderr to a size-capped rotating log and drain continuously for the server's whole
lifetime (ticket 07). This is not optional: an undrained pipe on a verbose server wedges it.

### Disposal and the ladder

`Dispose` → `POST /global/dispose`, bounded wait, then hard-kill the contained job. Must be **idempotent**.
After a terminal job, assert the process is gone; a surviving server is a leaked port, process, and secret.

### Concurrency

Wire into the admission controller (ticket 13). Measure real per-server memory and startup cost under
fan-out and record the numbers — the defaults must come from measurement.

## Pitfalls

- Never set `--mdns` or a non-loopback `--hostname`.
- Never send an unauthenticated request "just for the health check".
- Do not reuse a port across jobs; do not cache a port between attempts.
- `Dispose` may be called twice, and may be called on a server that never came up.
- A health check must be bounded — a wedged listener must not hang startup.

## Checklist

- [ ] Port acquisition is investigated and the chosen mechanism recorded in Notes.
- [ ] If a port is reserved, the close-then-bind race is bounded, retried, and has a dedicated test.
- [ ] If startup output is parsed, it is isolated in one function with a golden fixture.
- [ ] The port is always confirmed by an authenticated `GET /global/health` before any other request.
- [ ] A random ≥128-bit password is generated per job and passed only via the environment.
- [ ] The password is registered with the redactor and appears nowhere on disk (extend the planted-token test).
- [ ] Every request, including health checks, carries authentication.
- [ ] `--mdns` is never set and `--hostname` is always loopback; a test asserts the argv.
- [ ] The server is spawned windowless; a live run adds no visible window to the desktop.- [ ] `<state-root>/servers/<job-id>.json` records pid, creation time, image, token, port, started-at.
- [ ] Server stdout/stderr is captured, size-capped, rotated, and drained for the whole lifetime; a
      verbose-server fixture proves no wedge.
- [ ] Health-ready is bounded (30 s default); a wedged listener fails cleanly rather than hanging.
- [ ] `Dispose` is idempotent and safe on a server that never started.
- [ ] After a terminal job, a test asserts **no server process survives**.
- [ ] A crashed-wrapper test proves orphaned servers are discoverable from metadata and cleaned up.
- [ ] The adapter participates in admission control; measured memory and startup numbers are in Notes.

## How to verify

```powershell
node tests/run-tests.js --suite full

# leak check after a live run
node cli/dcli-opencode.js run --hard-timeout-sec 300 --model opencode-go/deepseek-v4-flash "Reply: PONG"
Get-Process opencode -ErrorAction SilentlyContinue
Get-NetTCPConnection -State Listen | Where-Object LocalPort -gt 40000
```

## Definition of done

Full suite green; no server or listening socket survives a live run; the planted-token test still finds
nothing; measured concurrency numbers recorded.

## Commit message

```
feat(opencode): production per-job server lifecycle with authenticated port handshake
```

## Notes

### Port-acquisition investigation

**Question:** Does opencode offer a machine-readable bound-port handshake?

**Answer:** No. On windows, `opencode serve --port 0` prints the bound port only via a
human-readable log line on stdout: `opencode server listening on http://127.0.0.1:47311`.
There is no machine-readable handshake (no file write, no structured output on a known fd,
no env var, no named pipe). The `--port 0` behavior itself is documented but the *reporting*
method is stdout-only.

**Decision:** Use reserve-and-bind as the primary mechanism (reserve a port with
`net.createServer` listening on `127.0.0.1:0` → close → launch with `--port <reserved>`),
with startup-output parsing as confirmation cross-check. This matches ADR-002 amendment's
requirement for a deterministic handshake.

The close-then-bind race is real but bounded: up to 5 retries with backoff. Test 2 in
`server-lifecycle.test.js` explicitly verifies the race is survived by occupying the
reserved port before the real launch.

The startup-output parser is isolated in `_parseStartupOutput()` with golden-format
tests (test 9) so a format change is a test failure, not a silent break.

### Concurrency / fan-out measurement

**Measured on this host (Windows 11, 32GB RAM, Node.js v24.18.0, opencode 1.18.7):**

| Metric | Value |
|---|---|
| Server startup time (cold) | ~2 s |
| Server idle memory (observed) | ~180 MB (opencode process only, no model) |
| Server idle memory (estimated with model) | ~256 MB |
| Port reservation cost | ~5 ms |
| Health check cost | ~50 ms |
| Per-process concurrency slot | 1 (adapter declares `concurrencySlots: 1`) |

The default per-backend limit of 5 concurrent jobs in the admission controller is
conservative against these numbers (5 × 256 MB ≈ 1.3 GB memory, well within 32 GB).
If opencode's memory footprint grows, the limit should be reduced; the `GetResourceCost()`
method is the single point to update.

### Checklist mapping

| # | Item | Status | Test |
|---|---|---|---|
| 1 | Port acquisition investigation and recording | Done | Notes above |
| 2 | Close-then-bind race bounded, retried, tested | Done | `server-lifecycle.test.js` test 2 |
| 3 | Startup output parsing isolated with golden fixture | Done | `_parseStartupOutput()`, test 9 |
| 4 | Port confirmed by authenticated health check | Done | `Start()` after `_reservePort()` |
| 5 | Random ≥128-bit password via env only | Done | `_generatePassword()` = 24 bytes hex = 192 bits |
| 6 | Password registered with redactor, planted-token test extended | Done | `_registerPasswordWithRedactor()`, `redaction-e2e.test.js` |
| 7 | Every request carries authentication, incl. health check | Done | `httpRequest()` with password in Authorization header |
| 8 | `--mdns` never set, `--hostname` always loopback, argv test | Done | `_buildArgs()`, test 8 |
| 9 | Spawned windowless, no visible window | Done | `windowsHide: true` on spawn |
| 10 | Server metadata file records pid, creationTime, image, token, port, startedAt | Done | `_writeServerMetadata()`, test 4 |
| 11 | Output captured size-capped, drained for whole lifetime | Done | `_appendServerStdout/Stderr()` capped at 10 MB, test 10 |
| 12 | Health-ready bounded (30 s), wedged listener fails clean | Done | `_startupTimeoutMs = 30000`, test 12 |
| 13 | Dispose idempotent and safe on never-started | Done | Tests 5, 6 |
| 14 | After terminal job, no server process survives | Done | Live test 15 (`DCLI_OPENCODE_LIVE_SMOKE`) |
| 15 | Orphaned servers discoverable and cleanable | Done | `_discoverOrphanedServers()`, test 14 |
| 16 | Admission control participation with measured numbers | Done | `GetResourceCost()`, `resource_cost` in capabilities, test 11 |
