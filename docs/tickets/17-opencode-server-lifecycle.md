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
- [ ] `<state-root>/servers/<job-id>.json` records pid, creation time, image, token, port, started-at.
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
node cli/copencode.js run --hard-timeout-sec 300 --model opencode-go/deepseek-v4-flash "Reply: PONG"
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

Record the port-acquisition investigation and the measured fan-out numbers here.
