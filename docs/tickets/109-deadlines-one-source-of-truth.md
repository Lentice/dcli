# 109 — deadlines: the shipped boundaries must read `core/deadlines.js`, and §13 must describe what ships

**Status:** done
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

**Wired (item 1):**
- `POST_EXIT_DRAIN_MS`: `adapters/shared/process-lifecycle.js` — removed the local `const
  POST_EXIT_DRAIN_MS = 3000`, `_waitForStreamDrain` now computes its deadline via
  `resolveDeadline('POST_EXIT_DRAIN_MS')` at call time (so `DCLI_POST_EXIT_DRAIN` is read fresh on
  every drain, not baked in at module load). Shipped value is now 5000ms, matching the table and the
  pre-existing `tests/core/deadlines.test.js` pins.
- `LOCK_ACQUISITION_MS`: `core/locking.js` — removed the local `DEFAULT_TIMEOUT_MS = 10000` constant
  and its export; `LockManager`'s constructor now defaults `_timeoutMs` to
  `resolveDeadline('LOCK_ACQUISITION_MS')` when no explicit `timeoutMs` option is given. Value
  unchanged (10000ms), no env override added (ticket did not ask for one; `ENV_OVERRIDES` only carries
  overrides with a documented `DCLI_*` name).

**Two-phase HTTP deadlines (item 2):** `adapters/opencode/transport.js` — `HttpTransport.request()`
now accepts either a caller-supplied `signal` (single deadline, unchanged legacy path) or a
`connectMs`/`readMs` pair. In the pair path it builds its own `AbortController`, arms a `connectMs`
timer, and — once `fetch()` resolves (response headers have arrived) — clears that timer and arms a
fresh `readMs` timer bounding the subsequent `res.text()` body read; either phase's expiry aborts the
same controller. `requestJson()` picks the path: an explicit per-call `timeoutMs` (e.g. the opencode
server's health check, `server.js` `HEALTH_TIMEOUT_MS`) still wins as one deadline covering the whole
call; when no `timeoutMs` is given it uses `resolveDeadline('HTTP_CONNECT_MS')` /
`resolveDeadline('HTTP_READ_MS')` for the two independent phases. The old module-level
`DEFAULT_TIMEOUT_MS = 10000` constant and export were removed (dead — no external importer, and the
two-phase default replaces its role).

**Deleted (item 3):** `WORKER_STARTUP_SENTINEL_MS`, `BACKEND_FIRST_EVENT_WATCHDOG_MS`,
`BACKEND_HEALTH_READY_MS`, `EVENT_STREAM_IDLE_MS` removed from `core/deadlines.js` `DEFAULTS` (and
`WORKER_STARTUP_SENTINEL_MS`'s `DCLI_STARTUP_TIMEOUT` row from `ENV_OVERRIDES`); `HTTP_CONNECT_MS`/
`HTTP_READ_MS` overrides were already present and untouched. `tests/core/deadlines.test.js` updated to
match (required-keys list and value assertions for the four removed keys dropped).

**§13 amended (item 4), `docs/design-spec.md`:**
- "Worker startup sentinel" row → describes the shipped bound: `core/worker-spawn.js`'s 1s
  spawn-event/error-journal settle (not a `resolveDeadline` key).
- "Backend startup / no-first-event watchdog" row → replaced with "opencode server health-ready",
  describing the shipped `adapters/opencode/server.js` `HEALTH_TIMEOUT_MS` (10s), explicitly noted as
  a single caller-supplied `timeoutMs` to `requestJson`, **not** wired through
  `resolveDeadline('HTTP_CONNECT_MS')` — an honest mapping call per the ticket's instruction, since it
  is one deadline for the whole health call, not the connect/read pair the table key names.
- "SSE idle" row → replaced with "REST-poll idle confirmation", restated at its actual shipped value
  (`adapters/opencode/turn.js` `IDLE_CONFIRM_MS` = 3s), not wired to a deadlines key (the key was
  deleted in item 3 since nothing consumed it).
- The watchdog paragraph ("Explicitly detect the study §5 hang class…") was replaced with a paragraph
  stating plainly that no first-event watchdog is implemented, naming what actually bounds the
  permission/question interaction loop instead (the REST-poll loop in `turn.js`, bounded by the turn's
  own hard timeout) — per Non-goals, implementing the watchdog itself is out of scope for this ticket.

**Call-site test (item 5):** added `tests/core/deadlines-wiring.test.js`, exercising the four wired
keys against their real production consumers rather than the table:
- A: `DCLI_POST_EXIT_DRAIN=80` changes `process-lifecycle`'s actual drain wait duration on a fake
  adapter instance that never closes its streams (asserts elapsed time and the recorded
  `drain_timeout` fact).
- B1: `DCLI_HTTP_READ_TIMEOUT=80` against a real HTTP server that sends headers immediately but never
  writes a body — proves the read phase is independently bounded.
- B2: `DCLI_HTTP_CONNECT_TIMEOUT=80` against `192.0.2.1` (RFC 5737 TEST-NET-1, guaranteed unroutable)
  with a 5000ms read bound — proves the connect phase is independently bounded (the real OS-level
  connect attempt to that address would otherwise hang far longer than 80ms).
- C: a `LockManager` built without an explicit `timeoutMs` has `_timeoutMs === resolveDeadline('LOCK_ACQUISITION_MS')`.

**Suite / checks:**
- `npm run check` — green (lint + full suite, `test:full` includes the new
  `deadlines-wiring.test.js`).
- Agent checks — all three ran and matched the ticket's expected output exactly:
  `rg -l "resolveDeadline" core/ adapters/` lists `transport.js`, `process-lifecycle.js`,
  `cli-args.js`, `attempt-driver.js`, `doctor.js`, `review.js`, `deadlines.js`, `locking.js`; the
  named-key grep shows every hit routed through `resolveDeadline(...)`, no bare numeric
  redeclaration; the removed-keys grep over `core/ adapters/ docs/design-spec.md` returns nothing.

**Deviations / discoveries:**
- While building the connect-timeout call-site test, a silent-TCP-server approach (`net.createServer`
  that accepts a connection and never writes a response) intermittently produced a process that exited
  0 with buffered `console.log` output apparently lost, rather than a clean pass/fail — root cause not
  fully isolated (suspected Windows-specific socket-handle/stdout-flush interaction under that exact
  connect/abort sequence, not reproduced in smaller isolated repros). Switched the test to the
  RFC 5737 TEST-NET-1 address instead, which is deterministic and is a standard technique for
  connect-timeout tests; the transport code path itself was verified correct in isolation (rejects in
  ~90ms as expected) before making the switch, so this is a test-construction finding, not a
  transport defect. Left here per AGENTS.md's "write it into the ticket's Notes" — worth a closer look
  if the silent-TCP pattern is reused elsewhere in this suite.
- `core/commands/review.js` calls `resolveDeadline('GIT_SPAWN_TIMEOUT_MS', GIT_SPAWN_TIMEOUT_MS)` — a
  key with no `DEFAULTS` entry, always given an explicit supplied value. Pre-existing, out of this
  ticket's scope (not one of the keys the ticket named), left untouched.
