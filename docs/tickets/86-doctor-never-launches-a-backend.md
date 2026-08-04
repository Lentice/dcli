# Ticket 86 — `doctor` reports all-green without ever launching a backend

**Status:** open (2026-08-04)
**Tier:** trust. `doctor` is what every failure path tells the user to run, and it is the one command that
answered "everything is fine" while no opencode job could complete a single request.
**Blocked by:** none — can start immediately.
**Filed from:** ticket 81's Notes, which recorded this and said it needed its own ticket.

---

## Symptom

While every opencode job was running to its hard timeout and producing zero bytes, `doctor --json`
reported every check `ok: true`, with `live_smoke_timeout_sec: null`.

## Root cause

`core/commands/doctor.js` gates the live smoke on the flag itself:

```js
if (liveSmokeTimeoutSec) { … }
```

So the only check that starts a backend and asks it to do something is off unless the caller passes
`--live-smoke-timeout-sec`. Everything that runs by default is static: the executable resolves, the
version parses, the state root is writable. `DOCTOR_LIVE_SMOKE_MS` (120 s) exists in `core/deadlines.js`
as the smoke's *deadline* — nothing uses it as the smoke's *default*.

A health check that never exercises the thing it certifies cannot report that the thing is broken. The
failure-class table sends users here for exit 12, 13 and 26, so an all-green `doctor` in front of a
backend that cannot answer is worse than no `doctor` at all — it converts a backend problem into a
"the tool is lying" problem.

## What to build

`doctor` exercises the backend by default: it starts one, sends a trivial prompt, and reports what came
back, bounded by `DOCTOR_LIVE_SMOKE_MS` with `--live-smoke-timeout-sec` as the override. A run that
cannot complete a request is not `ok`.

The bound is the whole design. Per AGENTS.md invariant #3 nothing may block forever, and per the startup
sentinel rule the window needs slack plus a dead-backend fast-fail so a real failure is not slow. An
opt-out (`--no-live-smoke`, or `--live-smoke-timeout-sec 0`) is fine for a static-only check — what is not
fine is that the static-only answer is today's default and calls itself green.

## Acceptance criteria

- [ ] **A.** `doctor` with no flags starts the backend, completes a trivial request, and reports the
  result. `live_smoke_timeout_sec` in the output reflects the deadline actually used, never `null` when a
  smoke ran.
- [ ] **B.** A backend that cannot answer produces a non-ok `doctor`, with a detail naming what failed and
  a failure class consistent with the exit-code table.
- [ ] **C.** The smoke is bounded, and a backend that dies at startup fails fast rather than waiting out
  the full window.
- [ ] **D.** Opting out of the live smoke is explicit and is reported as reduced coverage in the output —
  a static-only run must not be indistinguishable from a full one. If coverage is reduced, say so.
- [ ] **E.** A test asserts a non-ok `doctor` against a backend that is present but cannot serve a
  request — the case that was green while nothing worked. Not a mocked adapter: the point of this check
  is the path a mock removes.
- [ ] **F.** `npm run check` green; README, `docs/reference/*` and `integration/source/*` updated in the
  same commit, since every skill points users at `doctor` for diagnosis.

## Notes

- 2026-08-04: `--live-smoke-timeout-sec` already exists and works; only the default is wrong. The smallest
  correct change may be a default value rather than new machinery — but the coverage statement in D is
  part of the fix, not a nicety.
