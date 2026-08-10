# 93 — One table owns failure class ↔ exit code; today there are three

**Status:** ready
**Blocked by:** —
**Tier:** Correctness of a binding, append-only contract. The exit-code mapping is what agent callers
branch on, and it is currently three unconnected constant tables that must be kept in sync by hand.
**Filed from:** architecture review, 2026-08-10 (verified by grep against the tree at `adcbac1`).

---

## Symptom / Goal

`docs/design-spec.md` §7 defines the exit-code contract and §8 defines failure classification. The
implementation of the class ↔ code mapping exists three times:

```
core/commands/index.js:170-175   FAILURE_EXIT_CODES = { authentication: 13, quota_or_rate_limit: 14,
                                                        permission_or_sandbox: 15, network_error: 16 }
core/commands/doctor.js:136-145  smokeExitCode()  — the same 13/14/15/16, plus 12 and 26
core/reducer.js:189-194          the inverse map  { 13: 'authentication', 14: 'quota_or_rate_limit',
                                                    15: 'permission_or_sandbox', 16: 'network_error' }
```

Adding a failure class, or making `doctor` and the job path agree on a new one, means editing three
files that share no import. A fix landing in one of the three is the failure mode
`docs/engineering/lessons.md` warns about most.

Goal: one module owns the mapping in both directions; the other three sites import it.

## Root cause

There is no module named for this contract, so each consumer built the table it needed where it needed
it. `core/commands/index.js` is a grab-bag (see ticket 98), which is why the first table landed there
rather than somewhere findable.

## Binding constraints — quoted, do not go looking for them

From `docs/design-spec.md` §7:

> Stable and append-only. Backend-native codes (opencode returns only `0`/`1`, study §4) are
> translated, never surfaced.
>
> | `12` | Environment or compatibility failure |
> | `13` | Authentication failure |
> | `14` | Quota or rate-limit failure |
> | `15` | Permission / access-policy denial |
> | `16` | Network / transport failure |
> | `26` | Backend output/event protocol incompatible or malformed |

From `docs/design-spec.md` §8:

> **Bare numbers must never classify on their own.** Study §4 is the proof: opencode reported credit
> exhaustion as HTTP **401** with `responseBody.error.type == "CreditsError"`. Classifying that `401`
> as `auth` would send the operator to re-authenticate a working login. The discriminator is the
> structured error type, not the status code.

That clause constrains *classification*, not this ticket's mapping — but the new module must not become
a place where a bare number is turned into a class outside the sentinel path that legitimately does so.

Invariant 4 applies directly: this is an append-only contract. **No value in any of the three tables
may change** during this ticket. If the three disagree on any entry, stop and record the disagreement
in Notes rather than picking a winner.

## Files to read and trace first

- `core/commands/index.js` — `FAILURE_EXIT_CODES`, `classifyTerminalFailure`, `terminalExitCode`, and
  every importer of those three symbols.
- `core/commands/doctor.js` — `smokeExitCode()`; note it carries two codes (12, 26) the others do not.
- `core/reducer.js` — the inverse map, used when reading a worker completion sentinel's exit code back
  into a failure class.
- `core/commands/attempt.js`, `core/commands/worker.js` — consumers of `classifyTerminalFailure` and
  `terminalExitCode`.
- `tests/core/backend-failure-reason.test.js` and any test asserting a specific exit code — these pin
  the values and must pass unchanged.

## What to build

### 1. `core/failure-class.js`

```js
FAILURE_CLASSES              // frozen list of the known class names
failureClassToExitCode(cls)  // -> number | null
exitCodeToFailureClass(code) // -> string | null
classifyTerminalFailure(...) // moved verbatim from core/commands/index.js
terminalExitCode(...)        // moved verbatim from core/commands/index.js
```

The two directions are derived from **one** literal object, so they cannot disagree.

### 2. Rewire the three sites

- `core/commands/index.js` re-exports `classifyTerminalFailure` and `terminalExitCode` from the new
  module for one commit if that keeps the diff small, but the definitions move.
- `core/commands/doctor.js` `smokeExitCode()` calls `failureClassToExitCode()`; the 12 and 26 entries
  become entries in the shared table, since they are already contract values from §7.
- `core/reducer.js` calls `exitCodeToFailureClass()`.

### 3. A test that proves round-tripping

For every class in `FAILURE_CLASSES` with a code, `exitCodeToFailureClass(failureClassToExitCode(c))
=== c`.

## Non-goals

- **Changing any mapping.** Append-only. If `doctor` and the job path disagree, that is a finding for
  Notes and a separate ticket, not a fix here.
- **Moving the rest of `core/commands/index.js`.** That is ticket 98, which is blocked on this one so
  the exit-code contract lands in its own commit and is reviewable on its own.
- **Touching §8 classification precedence.** The mapping is not the classifier.

## Acceptance criteria

- [ ] **A.** `core/failure-class.js` exists and holds exactly one literal mapping of class to exit code.
- [ ] **B.** `core/commands/doctor.js` and `core/reducer.js` contain no numeric exit-code literals for
  failure classes; they call the new module.
- [ ] **C.** A round-trip test covers every class that has a code.
- [ ] **D.** Every existing test asserting an exit code passes **unchanged**. No test's expected value
  is edited in this commit.
- [ ] **Z.** `npm run check` green; `docs/reference/*` updated if any documented table moved file.

## Agent checks

```bash
# The three duplicate tables are gone; only the new module names the classes with codes.
grep -rn "quota_or_rate_limit: 14\|14: 'quota_or_rate_limit'" core/
# expect: at most one line, in core/failure-class.js

# doctor and reducer no longer hardcode class exit codes.
grep -nE ":\s*(12|13|14|15|16|26)\b" core/commands/doctor.js core/reducer.js
# expect: no line that is a failure-class-to-code mapping

# No expected exit code changed anywhere in the suite.
git diff --stat -- tests/
# expect: no test file's expected exit-code assertions modified

npm run check
# expect: green
```

## Handoff

**Extra reading, beyond `AGENTS.md` and `00-onboarding.md`** — `docs/design-spec.md` §7 and §8, quoted
above in full. Nothing else is needed.

**Implementation order:**

1. **Write down the three tables side by side before you change anything.** Put the comparison in Notes.
   If any entry disagrees between the three, **stop and ask** — invariant 4 makes picking a winner a
   contract change, which is not this ticket's authority.
2. Write the round-trip test (criterion C) against a `core/failure-class.js` that does not exist yet.
   Verify red.
3. Create `core/failure-class.js` with one literal object, deriving both directions from it.
4. **Move** `classifyTerminalFailure` and `terminalExitCode` verbatim. No edits to their bodies.
5. Rewire `doctor.js`, then `reducer.js`, one at a time, running the suite after each.
6. Remove the re-export from `core/commands/index.js` only if every importer has been updated; leaving
   it in place for one commit is acceptable and is cleaned up by ticket 98.

**Running tests while you work:**

```bash
node tests/core/backend-failure-reason.test.js
npm run check
```

**Traps specific to this ticket:**

- `doctor.js`'s table carries `12` and `26`, which the other two do not. Those are real contract values
  from §7 — bring them into the shared table rather than dropping them.
- `reducer.js`'s map is the **inverse** direction: it reads a worker completion sentinel's exit code back
  into a class. Deriving it from the same literal is the point of this ticket; hand-writing a second
  literal for it is the defect returning.
- Do not let `core/failure-class.js` become a classifier. §8's precedence rules (structured error type
  before bare status code) stay where they are.
- No test's expected exit code may change. If one has to, you have changed a mapping — stop.

**Commit message:**

```
ticket 93: one module owns failure class to exit code
```

## Notes

(Left empty by the author.)
