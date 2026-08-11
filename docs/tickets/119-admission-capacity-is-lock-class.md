# 119 — local admission capacity is reported as quota/rate-limit (exit 14) instead of the `lock` class

**Status:** done
**Blocked by:** —
**Tier:** Exit 14's contract tells the one consumer that matters — the delegating agent — "note
it, never retry-loop". A locally-transient "the local queue is full" is delivered as "you are out
of provider credit", and the error message's own advice ("Try again later") contradicts the class
the exit code assigns.
**Filed from:** 2026-08-11 dual-backend audit (claude F-5)

---

## Symptom / Goal

When the local admission controller is at capacity, `openAttempt` throws:

`core/job-setup.js:109-112`:
```js
const err = new Error('System at capacity (global: ...). Try again later or use "submit" instead.');
err.exitCode = 14;
```

Exit 14 is "Quota or rate-limit failure" (`docs/design-spec.md` §7), and the §8 reaction is:
"`quota_or_rate_limit` | Note it; continue without the delegated work. **Never retry-loop.**"
Every generated skill therefore teaches agents never to retry a 14 — including the local,
transient, retryable "all five slots are busy right now" case, whose message says to try again.

## Root cause

The nearest-looking exit code was reused for a locally-transient condition. Admission slots are a
lock-like resource; the §8 `lock` class already exists with the correct reaction: "`lock` |
Bounded backoff retry, then fail."

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §7: "`17` | Lock acquisition or corrupt-state failure"

`docs/design-spec.md` §8, reaction table:
"`lock` | Bounded backoff retry, then fail."
"`quota_or_rate_limit` | Note it; continue without the delegated work. Never retry-loop."

`AGENTS.md` invariant 4 (append-only contracts) — satisfied: this ticket **adds** a mapping,
never renames or repurposes an existing one. `14` and `quota_or_rate_limit` keep their meanings;
the capacity error simply stops claiming to be one.

## Files to read and trace first

- `core/job-setup.js:100-115` — the capacity error construction (both the `global_limit` and
  `backend_limit` branches if both throw here — read the surrounding code; the audit quoted the
  global branch).
- `core/failure-class.js` — the single owner of class ↔ exit code (ticket 93): the frozen
  `FAILURE_CLASS_TO_EXIT_CODE` literal (`:11-18`), both directions derived from it.
- `core/envelope.js` (or wherever the `--json` envelope carries `failure_class`) — trace how the
  class reaches the JSON output so the new class is reported, not just the code.
- `docs/design-spec.md` §7/§8 — verify whether any text needs the new mapping documented (see
  What to build, item 3).
- `tests/core/failure-class.test.js` and `tests/core/job-setup.test.js` — extend.

## What to build

1. **Add `lock: 17` to `FAILURE_CLASS_TO_EXIT_CODE`** in `core/failure-class.js` (append-only
   addition; both directions derive automatically). This is the contract-owning place — the
   store's direct `17` throws (`core/job-store.js:63, 211, 643, 686`,
   `core/job-lookup.js:34, 56, 62`) are not touched by this ticket unless they already carry a
   class; the goal is only that the capacity path reports `lock`/17 honestly.
2. **Reclassify the capacity error** in `core/job-setup.js`: `err.exitCode = 17` and
   `err.failureClass = 'lock'` (or whatever the envelope's mechanism is — trace item 3 of Files
   to read; the observable contract is `failure_class: "lock"` in `--json` output and exit 17).
   Keep the message's "Try again later or use `submit` instead." — it now matches the class.
3. **Docs.** If §7's 17 row or §8's `lock` row needs a note that admission capacity classifies
   here (the spec only needs it if the mapping table names every class — check), add one line.
   Also verify `integration/source/*` teaches no "never retry 14" rule that this change
   invalidates — it does not: 14 keeps its meaning.
4. **Tests.** failure-class test asserts `lock ↔ 17` both directions; job-setup capacity test
   asserts exit 17 and the `lock` class in the envelope.

## Non-goals

- **No new exit code.** (The audit offered 17 or a new appended code; 17 + the existing `lock`
   class is chosen because §8 already defines the right reaction and §7 already defines 17 —
   nothing new to invent.)
- **No change to genuine quota/rate-limit classification** anywhere else.
- **No change to admission queueing** (that is ticket 107).

## Acceptance criteria

- [ ] **A.** At-capacity `run`/`submit` fail with exit 17 and `failure_class: "lock"` in
  `--json` output.
- [ ] **B.** `failureClassToExitCode('lock') === 17` and `exitCodeToFailureClass(17) === 'lock'`.
- [ ] **C.** Genuine `quota_or_rate_limit` sites still map to 14 (unchanged).
- [ ] **Z.** `npm run check` green; the tracker table regenerated.

## Agent checks

```bash
# What this proves: the mapping owns both directions and is append-only.
node -e "const m = require('./core/failure-class.js'); console.log(m.failureClassToExitCode('lock'), m.exitCodeToFailureClass(17))"
# expect: 17 lock

# What this proves: no capacity site still reports 14.
rg -n "exitCode = 14|quota" core/job-setup.js
# expect: (nothing)

npm test -- --grep "failure-class|capacity"   # expect: green
```

## Notes

Implemented 2026-08-11, one commit.

**What was changed and where**

- `core/failure-class.js` — added `lock: 17` to the frozen `FAILURE_CLASS_TO_EXIT_CODE`
  literal (append-only; both directions derive, so criterion B holds by construction).
- `core/job-setup.js:109-118` — the capacity error now sets `err.exitCode = 17` and
  `err.failureClass = 'lock'`; the message (incl. "Try again later or use `submit`
  instead.") is unchanged and now matches the class.
- `cli/dcli.js` — the `--json` envelope does NOT carry `failure_class` for setup errors:
  `buildEnvelope` is emitted only for jobs that got created, and an at-capacity error
  previously propagated to `main().catch`, which printed the message and exited with no
  JSON at all. Added the missing mechanism: `main()` records the parsed args, and the
  catch handler emits `{ schema_version: 1, failure_class, detail }` on stdout when
  `--json` was requested and the error carries a `failureClass` (this also gives the
  adapters' existing `unsupported_capability` errors their spec-mandated §7 JSON output).
  Errors without a `failureClass` keep the old stderr-only behavior.
- `docs/design-spec.md` §7 — the `17` row now notes that local admission capacity
  classifies here as `lock`, never as `14`. §8's `lock` row already carried the correct
  reaction; no change there.
- `integration/source/*` — verified per ticket item 3: nothing teaches a "never retry
  14" rule that this change invalidates; 14 keeps its meaning, so no source change.

**Tests (written first, verified red, then green)**

- `tests/core/failure-class.test.js` — explicit `lock ↔ 17` both directions plus the
  unchanged `quota_or_rate_limit ↔ 14` assertions (criterion B and C).
- `tests/core/setup-failure.test.js` — the existing "admission full" case now expects
  exit 17 and `failureClass: 'lock'`; added a CLI-level case: three fake slots held by
  the test process, then `run --json` exits 17 and stdout parses to
  `failure_class: "lock"` with the retry advice intact (criterion A).

**Build and suite results**

`npm run check` (eslint + full suite): green. adapters 33, contract 2, core 60,
helpers 1, integration 3 — all passed, exit 0. Tracker table regenerated with
`scripts/generate-tickets-table.js`.

**Agent checks — actual output**

```
$ node -e "const m = require('./core/failure-class.js'); console.log(m.failureClassToExitCode('lock'), m.exitCodeToFailureClass(17))"
17 lock

$ rg -n "exitCode = 14|quota" core/job-setup.js
(no matches, exit 1)

$ npm test -- --grep "failure-class|capacity"
Cannot run as written: this repo's runner (tests/run-tests.js) has no --grep flag.
Ran the two files directly instead — both green:
  node tests/core/failure-class.test.js  → PASS
  node tests/core/setup-failure.test.js  → PASS
```

**Deviations from the ticket**

- `tests/core/job-setup.test.js` does not exist; the openAttempt-failure tests live in
  `tests/core/setup-failure.test.js` (ticket 95's file), which was extended instead.
- The ticket's item 2 asked to trace "wherever the `--json` envelope carries
  `failure_class`". It does not, on the setup path — see the `cli/dcli.js` change above,
  which is the minimal mechanism that makes criterion A's `failure_class: "lock"`
  observable.
- Criterion A says "run/submit". `submit` never throws the capacity error: it calls
  `openAttempt` with `admission: null` and the detached worker queues the job instead
  (`core/commands/worker.js`). The criterion is satisfied at the single shared error
  construction site (openAttempt), which the "use `submit` instead" advice points at.
- The audit quoted only the `global_limit` branch; the current code has one shared
  construction site (`!result.acquired` covers contention/global/backend limits alike),
  so one reclassification covers all three.
- No change to `integration/source/core.md`'s exit table: it has no `17`/`lock` row and
  the ticket scoped docs to design-spec §7/§8 only. If a future ticket adds a `lock`
  row there, it should say "bounded backoff retry, then fail".

