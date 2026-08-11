# 119 — local admission capacity is reported as quota/rate-limit (exit 14) instead of the `lock` class

**Status:** ready
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

(Left empty by the author. The implementer fills it in: what was changed and where, build and suite
results, the Agent checks' actual output, any deviation from this ticket and why, and anything
discovered that contradicts the docs.)
