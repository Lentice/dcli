# 112 — worker startup failures write a string into the structured `failure` field and skip the completion sentinel

**Status:** done
**Blocked by:** —
**Tier:** The status contract requires `failure` to be a structured object; consumers cannot
classify or display a startup failure from a raw string. And the module's own stated invariant —
"every terminal exit routes through here so the completion sentinel cannot be written on some
paths and forgotten on others" — is violated by four of its own early exits, downgrading
`publishable` on any later reconciliation.
**Filed from:** 2026-08-11 dual-backend audit (codex F-4, claude F-9; verified by launching a
worker against a job with missing `params.json` — reduced status had `failureType: "string"`)

---

## Symptom / Goal

Two defects in the detached-worker startup paths (`core/commands/worker.js`):

1. **`failure` is a string, not the contract object.** `journalFailure()` writes
   `detail.failure: message` (`core/commands/worker.js:239`), and the crash handler writes
   `detail.failure: err.message` (`:261`). The status contract (§5) requires
   `{ "class": ..., "message": ..., "source": ... }`. Consumers that read `failure.class` /
   `failure.message` get `undefined` and `undefined` for every `worker_startup_failed` and
   `worker_crash` record.
2. **The completion sentinel is skipped on four terminal exits.** The params-read (`:51-53`),
   prompt-read (`:62-64`), adapter-load (`:122-124`) and validation (`:138-141`) paths each
   `journalFailure(...)` then `process.exit(...)` without going through `finish()` (`:200-208`),
   the only place `worker-complete.json` is written. The top-level `.catch` does write one
   (`writeCrashSentinel`, `:245-253,264-270`), so the omission is per-path, not global. The
   comment at `:194-199` states the intent; `finish()` is simply defined *after* the exits it was
   meant to serve.

## Root cause

The startup helper (and the crash handler) accept a bare message and bypass the structured
failure construction; and the sentinel-writing function is declared too late in the file for the
early exits to use it.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §5, `failure`, when present:

```json
{ "class": "quota_or_rate_limit", "message": "...", "source": "event|stderr|http|exit|wrapper",
  "matched_signal": "CreditsError", "confidence": "high", "http_code": 401, "retryable": false }
```

`docs/design-spec.md` §7: "`18` | Worker launch / startup-sentinel failure" — the sentinel the
startup-failure paths must now write is the same `worker-complete.json` the success path writes
(`core/commands/worker.js:200-208`), with `exit_code` and `state: 'failed'`.

## Files to read and trace first

- `core/commands/worker.js` — the whole file: the four early exits (`:34-38, :47-53, :58-64,
  :113-141`), `journalFailure` (`:227-243`), `finish` (`:200-208`), `writeCrashSentinel`
  (`:245-253`) and the top-level catch (`:255-281`).
- `core/reducer.js` — how `failure` and `publishable`/`completionSentinelPresent` are consumed, so
  the structured object and the sentinel land in the right shape.
- `core/commands/attempt-driver.js` — how the foreground path constructs the structured failure
  (e.g. `:284` `failure: { class: 'worker_launch', message: ..., }`) — mirror its shape.
- `tests/core/commands/worker*` — existing worker tests (e.g. the queued-path and crash tests).
- Grep for `failure_reason: 'worker_startup_failed'` and `'worker_crash'` consumers.

## What to build

1. **Structured failure in `journalFailure`.** `journalFailure` builds
   `failure: { class: <reason>, message: <message>, source: 'wrapper' }` (class = the reason
   value, e.g. `worker_startup_failed` / `validation_failed`, matching the shape the reducer and
   the §8 `worker_launch` / `unknown` classes expect; pick `source: 'wrapper'` — it is the
   wrapper process that observed the failure). `failure_reason` stays the reason string as today.
   Do the same in the crash handler (`:257-263`): `failure: { class: 'worker_crash', message:
   err.message, source: 'wrapper' }`.
2. **Sentinel on every terminal startup exit.** Introduce a single `writeSentinel(jobDir, code,
   state)` helper (the body of `writeCrashSentinel` is already one — move it above the first
   early exit and reuse it in `finish()`), and call it before `process.exit` on the missing-env
   (`:34-38` — it already has `stateRoot`/`repoKey`/`jobId` in scope), params-read (`:51-53`),
   prompt-read (`:62-64`), adapter-load (`:122-124`) and validation (`:138-141`) paths, each with
   `state: 'failed'`. The queued path (`:85-105`) is **not** terminal and must not write a
   sentinel.
3. **Tests.** A worker startup test with a missing `params.json` asserting: reduced status has
   `failure.class === 'worker_startup_failed'` and `failure.source === 'wrapper'`; and
   `attempts/1/worker-complete.json` exists with `exit_code: 1, state: 'failed'`. Mirror for the
   crash path.

## Non-goals

- **No change to the queued path** — it is not a terminal state and keeps journaling only.
- **No change to exit codes** (1 for startup, 2 for validation) — only the record shape and the
  sentinel.
- **No change to the foreground path's failure shape** — only the detached worker's startup
  records.

## Acceptance criteria

- [ ] **A.** Every `worker_startup_failed` / `worker_crash` / `validation_failed` record has
  `failure` as an object with `class`, `message` and `source`.
- [ ] **B.** Every terminal exit of `core/commands/worker.js` writes `worker-complete.json`
  before `process.exit` — including the four startup paths; the queued path writes none.
- [ ] **C.** Grep-level proof: no `process.exit` in `worker.js` without a preceding sentinel
  write on the terminal paths.
- [ ] **Z.** `npm run check` green; the tracker table regenerated.

## Agent checks

```bash
# What this proves: no terminal worker exit skips the sentinel.
rg -n "process.exit" core/commands/worker.js
# expect: every terminal-exit hit is preceded by writeSentinel(...) (the queued path's
#         process.exit(0) is the only one with no sentinel, and it is documented as such)

# What this proves: the failure shape is structured everywhere.
rg -n "failure:" core/commands/worker.js
# expect: only object literals with class/message/source; no bare message strings

# What this proves: the fix is covered.
npm test -- --grep "worker"   # expect: green, including missing-params and crash cases
```

## Notes

Implemented 2026-08-11.

**What changed and where**

- `core/commands/worker.js`:
  - `journalFailure()` now journals `failure: { class: <reason>, message, source: 'wrapper' }` (was the bare message string) at `:261`; the crash handler journals `failure: { class: 'worker_crash', message: err.message, source: 'wrapper' }` at `:280`. `failure_reason` unchanged.
  - New module-level `writeSentinel(jobDir, code, state)` helper at `:33-42` — the old `writeCrashSentinel` body moved above the first early exit, with two additions: a `null jobDir` guard (no usable state root ⇒ nothing to write into) and `fs.mkdirSync(attempts/1, recursive)` because the startup paths exit before `createAttemptDir` runs and the sentinel must land regardless.
  - `writeSentinel(..., 1, 'failed')` added before `process.exit` on the missing-env (`:56`), params-read (`:72`), prompt-read (`:84`), adapter-load (`:146`), attempt-dir-creation (`:176`) paths; `writeSentinel(..., 2, 'failed')` on the validation path (`:164`, exit code 2 preserved — non-goal). The queued path (`:129`) writes none. `finish()` (`:227-230`) and the crash handler (`:283-289`) reuse the helper; `writeCrashSentinel` deleted.
- `tests/core/worker-startup-failure.test.js` (new, `@suite full` / `@serial`): missing-`params.json` spawn asserts exit 1, reduced status `state: 'failed'`, `failure.class === 'worker_startup_failed'`, `failure.source === 'wrapper'`, message names the read failure, and `attempts/1/worker-complete.json` exists with `exit_code: 1, state: 'failed'`; crash mirror spawns with `params.json` = `"null"` (parses, then `params.executionToken` throws inside `main()`, rejecting into the top-level catch) and asserts the same for `worker_crash`.

**Build and suite**

- `npm run check`: green — lint clean; full suite 97/97 files passed (32 adapters, 2 contract, 59 core, 1 helpers, 3 integration), including the new `core\worker-startup-failure.test.js` (632 ms) and all sibling worker tests.

**Agent checks (actual output)**

- `rg -n "process.exit" core/commands/worker.js` → hits at `14, 57, 73, 85, 129, 147, 165, 177, 229, 299`. Every hit except two is preceded by a `writeSentinel(...)` call: `:129` is the queued path (documented no-sentinel exit), and `:14` is the `DCLI_WORKER !== '1'` misuse guard, which executes before the `require`s at `:17-23` load and before any job identity is guaranteed, so a sentinel is impossible (and would be wrong — a hand-run script must not publish evidence for a live job). The check's parenthetical said the queued path would be "the only one with no sentinel"; the guard is a second one, by necessity, and is not one of the ticket's terminal worker paths.
- `rg -n "failure:" core/commands/worker.js` → only the two object literals above; no bare message strings remain.
- `npm test -- --grep "worker"` → the runner has no `--grep` flag (rejects positionals, see `tests/run-tests.js`); equivalent worker coverage ran green via the full suite (`worker-startup-failure`, `worker-spawn`, `worker-liveness`, `worker-hard-timeout`, `worker-cancel-watcher`, `attempt-driver`).

**Deviations**

- The validation path writes `exit_code: 2` in its sentinel (its exit code per the non-goal "no change to exit codes"), where the ticket's test wording only specified `1` for the startup paths; the sentinel records the actual code.
- The `DCLI_WORKER` misuse guard (`:12-14`) is a no-sentinel exit by design (see above); it predates the `writeSentinel` helper's `require`s, so it cannot use it.
- Nothing discovered contradicted `docs/design-spec.md` or the onboarding docs. `status.attempt` stays null on these failure paths (no `attempt_created` entry is journaled), so `gatherEvidence` does not read the sentinel for these jobs — the job is already terminal `failed` from the journal, and the reducer treats terminal states as idempotent; the sentinel still lands for consistency and for any reader that looks for it directly.
