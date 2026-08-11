# 109 — deadlines: the shipped boundaries must read `core/deadlines.js`, and §13 must describe what ships

**Status:** ready
**Blocked by:** —
**Tier:** "Every documented recipe carries a budget" is a repository rule; six of the documented
deadlines in `docs/design-spec.md` §13 currently have no production consumer, and two that ship
carry different values than the spec and the tests assert. The env overrides
(`DCLI_POST_EXIT_DRAIN`, `DCLI_HTTP_READ_TIMEOUT`, …) are fiction today.
**Filed from:** 2026-08-11 dual-backend audit (claude F-3; every claim re-verified by grep against
the tree at `51e2d35`)

---

## Symptom / Goal

`core/deadlines.js` presents itself as the source of truth for every blocking boundary, but most
of its keys are never read in production:

- **`POST_EXIT_DRAIN_MS`: 5000 in the table and in tests, 3000 shipped.**
  `core/deadlines.js:7` and `tests/core/deadlines.test.js` assert 5000; the drain that actually
  runs is `adapters/shared/process-lifecycle.js:140` — `const POST_EXIT_DRAIN_MS = 3000;` — used
  at `:288`. A repo-wide grep shows **no** production call to
  `resolveDeadline('POST_EXIT_DRAIN_MS')`, so the documented `DCLI_POST_EXIT_DRAIN` env override
  has no effect on any real drain.
- **HTTP: spec says connect 10 s / read 60 s; the transport ships a single 10 s bound.**
  `adapters/opencode/transport.js:4` — `DEFAULT_TIMEOUT_MS = 10000` — bounds connect, response
  and body together (`AbortSignal.timeout(effectiveTimeout)` at `:187`). A 10 s read bound is
  ~6× tighter than the spec's 60 s.
- **Keys with zero production references** (verified by grep over `core/ adapters/ cli/` excluding
  `core/deadlines.js` itself): `WORKER_STARTUP_SENTINEL_MS`, `BACKEND_FIRST_EVENT_WATCHDOG_MS`,
  `BACKEND_HEALTH_READY_MS`, `EVENT_STREAM_IDLE_MS`, `HTTP_CONNECT_MS`, `HTTP_READ_MS`,
  `LOCK_ACQUISITION_MS`. Each boundary is instead re-declared locally:
  `core/locking.js:16` (`DEFAULT_TIMEOUT_MS = 10000`), `adapters/opencode/server.js:12-15`
  (`HEALTH_TIMEOUT_MS = 10000`), `adapters/opencode/turn.js:6` (`IDLE_CONFIRM_MS = 3000`),
  `adapters/opencode/adapter.js:672` (a hardcoded `5000` health probe).

The sharpest consequence: `docs/design-spec.md` §13 requires a "no-first-event watchdog" ("if a
permission or question request is pending while the session reports `busy` and no event has
arrived within the watchdog window…") and `BACKEND_FIRST_EVENT_WATCHDOG_MS` has no consumer — the
watchdog does not exist (verified: no `busy`/watchdog handling in the opencode adapter or turn
loop).

## Root cause

A central deadline table was written before the subsystems it describes and never wired. Each
subsystem grew its own local constant, and the tests test the table rather than the behavior, so
the divergence is invisible on green.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §13, table rows that must be satisfied by the shipped code after this
ticket:

```
| Post-exit stdout/stderr drain | 5 s |
| HTTP connect / read | 10 s / 60 s |
| File-lock acquisition | 10 s |
```

§13 rules: "Every HTTP operation carries an `AbortController` deadline." — the two-phase HTTP
change must keep that (see What to build, item 2).

`AGENTS.md`: "**Nothing blocks forever.** Every wait, read, lock, HTTP call, and drain has a
finite default." — deleting a deadlines key is only legal when the boundary it named does not
exist; deleting a key for a boundary that *does* exist but is not wired is not an option.

## Files to read and trace first

- `core/deadlines.js` — the whole file (table, env overrides, `resolveDeadline`).
- `tests/core/deadlines.test.js` — the tests that pin the table values.
- `adapters/shared/process-lifecycle.js` — `POST_EXIT_DRAIN_MS` (`:140`, `:288`) and the drain
  loop it bounds; `LIVE_DRAIN_RECHECK_MS` (`:139`) is a different concept, leave it.
- `adapters/opencode/transport.js` — `DEFAULT_TIMEOUT_MS` (`:4`), `requestJson`/request paths
  (`:174-190`) where the single `AbortSignal.timeout` is applied.
- `adapters/opencode/turn.js` — `IDLE_CONFIRM_MS` (`:6`) and the REST-poll idle-confirm loop
  (`:132-260`); the comment at `:20-30` explains it is a different concept from SSE idle.
- `core/locking.js` — `DEFAULT_TIMEOUT_MS` (`:16`) and where `_timeoutMs` is used.
- `adapters/opencode/server.js:12-15` and `adapters/opencode/adapter.js:672` — health-bound
  locals.
- `docs/design-spec.md` §13 (lines ~592-620) — the table and the watchdog paragraph.

## What to build

1. **Wire the boundaries that ship.** Each of these becomes a `resolveDeadline(...)` call at its
   production site (one-line change per site), so the table and its env overrides become real:
   - `POST_EXIT_DRAIN_MS` in `adapters/shared/process-lifecycle.js` — the shipped value becomes
     the table's 5000 ms (which the tests already pin).
   - `LOCK_ACQUISITION_MS` in `core/locking.js` (replacing `DEFAULT_TIMEOUT_MS`; the 10000 value
     is unchanged).
2. **Two-phase HTTP deadlines in the opencode transport.** `transport.js` must bound connection
   establishment at `HTTP_CONNECT_MS` (10 s) and the response/body read at `HTTP_READ_MS`
   (60 s) as separate finite deadlines: keep the existing `AbortController` seam, but replace the
   single `AbortSignal.timeout(effectiveTimeout)` with a controller whose connect deadline is
   cleared and replaced by the read deadline once response headers arrive. Both via
   `resolveDeadline`, so `DCLI_HTTP_CONNECT_TIMEOUT` / `DCLI_HTTP_READ_TIMEOUT` take effect.
   Keep `DEFAULT_TIMEOUT_MS` as the caller-supplied override path (an explicit per-call
   `timeoutMs` must still win — that is what the opencode server's health checks pass).
3. **Delete keys that name no boundary.** `WORKER_STARTUP_SENTINEL_MS`, `BACKEND_HEALTH_READY_MS`
   and `EVENT_STREAM_IDLE_MS` have no consumer and no §13 row that survives this ticket (see item
   4) — remove them from `DEFAULTS` (and their env-override rows where present), and update
   `tests/core/deadlines.test.js` accordingly. `BACKEND_FIRST_EVENT_WATCHDOG_MS` is treated the
   same way: the watchdog does not exist, and implementing it is a feature, not this ticket (see
   Non-goals).
4. **Amend §13 to describe what ships.** The table's rows for the deleted keys are replaced with
   the shipped boundaries:
   - "Worker startup sentinel | 30 s" → the worker launch confirmation that ships
     (`core/worker-spawn.js:81-113`: spawn event or error journal, 1 s settle).
   - "Backend startup / no-first-event watchdog | 120 s" → the shipped opencode health-ready
     bound (`adapters/opencode/server.js` `HEALTH_TIMEOUT_MS`, wired through
     `resolveDeadline('HTTP_CONNECT_MS')` if the health probe is an HTTP call — pick the honest
     mapping and say so in the table) — and delete the watchdog paragraph
     (`:618-620`, "**Explicitly detect the study §5 hang class:** …") or replace it with a
     sentence stating the hang-class detection is not implemented and how the shipped polling
     bounds it. Do not leave text that claims a watchdog exists.
   - "SSE idle (no event, no keepalive) | 120 s" → the shipped REST-poll idle confirmation
     (`adapters/opencode/turn.js` `IDLE_CONFIRM_MS`), wired through
     `resolveDeadline('EVENT_STREAM_IDLE_MS')` **or** restated with its actual 3 s value. Pick
     one: if the idle-confirm loop is the boundary §13 meant, keep the key and wire it; otherwise
     amend the row. State the choice in the table with a one-line note.
5. **A call-site test, not a table test.** Extend `tests/core/deadlines.test.js` (or add one
   next to it) so the wire is verifiable: assert that the production modules' *effective* values
   equal `resolveDeadline(...)` for the wired keys (import the modules with injected values, or
   grep-style structural assertions — pick the existing test style). The goal: a future local
   re-declaration fails the suite.

## Non-goals

- **No first-event watchdog implementation.** The §13 watchdog behavior (permission/question
  pending while `busy`) is real safety work with its own design; this ticket only stops the spec
  from claiming it exists.
- **No change to `LIVE_DRAIN_RECHECK_MS`** — it is a liveness-timer bound, not a deadline table
  boundary.
- **No behavior change beyond the value fixes in item 1 and 2.** Post-exit drain becomes 5 s,
  HTTP read becomes 60 s; everything else keeps its shipped value.

## Acceptance criteria

- [ ] **A.** `DCLI_POST_EXIT_DRAIN=1000` actually changes the post-exit drain bound of a real
  adapter run (test asserts the effective value).
- [ ] **B.** `DCLI_HTTP_READ_TIMEOUT` and `DCLI_HTTP_CONNECT_TIMEOUT` change the opencode
  transport's read and connect bounds independently.
- [ ] **C.** Every remaining `DEFAULTS` key in `core/deadlines.js` has at least one production
  reference outside `core/deadlines.js` and `tests/`.
- [ ] **D.** §13's table and watchdog paragraph describe only what ships; nothing in §13 claims a
  watchdog or a 120 s SSE idle bound that does not exist.
- [ ] **Z.** `npm run check` green; the tracker table regenerated; `docs/design-spec.md` §13
  updated in the same commit.

## Agent checks

```bash
# What this proves: every shipped deadline key is consumed by production code.
rg -l "resolveDeadline" core/ adapters/ --glob '*.js' | sort
# expect: process-lifecycle, transport, locking, and the existing consumers
#         (attempt-driver, doctor, cli-args, review); and:
rg -n "POST_EXIT_DRAIN_MS|LOCK_ACQUISITION_MS|HTTP_CONNECT_MS|HTTP_READ_MS" adapters/ core/locking.js
# expect: every hit goes through resolveDeadline, no bare numeric local redeclaration
#         (a bare `const X = 3000` is a failure of this check)

# What this proves: the removed keys are gone.
rg -n "WORKER_STARTUP_SENTINEL_MS|BACKEND_FIRST_EVENT_WATCHDOG_MS|BACKEND_HEALTH_READY_MS|EVENT_STREAM_IDLE_MS" core/ adapters/ docs/design-spec.md
# expect: (nothing)
```

## Notes

(Left empty by the author. The implementer fills it in: what was changed and where, build and suite
results, the Agent checks' actual output, any deviation from this ticket and why, and anything
discovered that contradicts the docs.)
