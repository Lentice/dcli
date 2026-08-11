# 115 — `read` returns success for a terminal job with no result artifact

**Status:** done
**Blocked by:** —
**Tier:** Exit 11 exists precisely for "no usable assistant result"; returning exit 0 with empty
text for a terminal job whose `result.md` is missing makes an absent result indistinguishable
from a deliberate empty one, and callers (agents) treat it as a clean result.
**Filed from:** 2026-08-11 dual-backend audit (codex F-7; verified with a terminal temp job whose
journal had `result_bytes: 0` but no `result.md` — `executeRead()` returned `exitCode: 0`,
`isTerminal: true`, empty text)

---

## Symptom / Goal

`dcli read <job-id>` on a terminal job initializes `text = ''`, reads `result.md` only when it
exists, and always returns `exitCode: 0` (`core/commands/read.js:8-22`). When the journal says
the attempt finished but no `result.md` was persisted, the command reports success with empty
output — a false clean result for a job whose artifact contract was violated.

## Root cause

`read` trusts the terminal state without validating the result artifact, and treats absence as an
empty valid result.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §7: "`11` | No usable assistant result"

`docs/design-spec.md` §5: "When an attempt collects a result, it writes `result.md` before its
terminal status projection." — a terminal status without `result.md` is therefore a violation
that must be surfaced, not papered over.

## Files to read and trace first

- `core/commands/read.js` — the whole file (24 lines).
- `core/commands/apply.js:48-63` and `core/commands/diff.js:14-32` — the established pattern for
  exit-11 errors: `const e = new Error(...); e.exitCode = 11; throw e;` (mirror the message
  style).
- `core/job-lookup.js` — `loadJobOrThrow`'s result (`attemptDir`), so the missing/empty
  distinction is judged against the right path.
- `tests/core/commands/read.test.js` (or wherever read is tested).

## What to build

1. **Distinguish the cases in `executeRead`:**
   - `result.md` exists (any size, including zero bytes) → today's behavior: exit 0, text (empty
     for a zero-byte file is an intentional empty result).
   - terminal state and `result.md` does not exist (or exists but is unreadable) → throw (or
     return) an exit-11 error naming the job and the missing artifact, matching the
     apply/diff pattern, with the envelope built as those commands do.
2. **Tests.** A terminal job with no `result.md` → exit 11, no text; a terminal job with a
   zero-byte `result.md` → exit 0 with empty text; a running job → exit 4 (unchanged).

## Non-goals

- **No change to `loadJobOrThrow`, the envelope, or exit 4/0 semantics.**
- **No automatic result recovery** — if the result file is genuinely gone, exit 11 is the truth.

## Acceptance criteria

- [ ] **A.** `read` on a terminal job without `result.md` exits 11 with a message naming the job;
  `isTerminal` stays true.
- [ ] **B.** `read` on a terminal job with a zero-byte `result.md` still exits 0.
- [ ] **C.** `read` on a running job still exits 4.
- [ ] **Z.** `npm run check` green; the tracker table regenerated.

## Agent checks

```bash
# What this proves: absence is an error, zero-byte presence is not.
rg -n "exitCode: 11|exitCode: 0" core/commands/read.js
# expect: a conditional that only reaches exit 0 when result.md exists (or is readable)

# What this proves: the fix is covered.
npm test -- --grep "read"   # expect: green, including the missing-artifact case
```

## Notes

**What changed and where.** `core/commands/read.js` — `executeRead()` no longer pre-initializes
`text = ''` and conditionally reads `result.md`. It now reads `result.md` unconditionally inside a
try/catch: on success it returns the today behavior (exit 0, text, envelope); on failure (missing or
unreadable artifact, e.g. ENOENT/EPERM) it throws `err.exitCode = 11` with a message naming the job
and the artifact path (`Job <id> has no readable result artifact: <path>`), matching the
apply.js/diff.js pattern. `loadJobOrThrow`, the envelope, and exit 4/0 semantics unchanged.

**Tests.** `tests/core/commands.test.js` — added test 2b (terminal job with no `result.md` →
`assert.rejects` with `exitCode === 11` and message naming the job) and test 2c (terminal job with a
zero-byte `result.md` → exit 0, empty text). Tests 1 (running job → exit 4) and 2 (terminal with
content → exit 0) were pre-existing and still pass.

**Build and suite.** `npm run check` green (exit 0; eslint + full suite). `node tests/core/commands.test.js`
green including the new tests; `node tests/core/result-persistence.test.js` green (sibling caller of
`executeRead`).

**Agent checks.**
1. `rg -n "exitCode: 11|exitCode: 0" core/commands/read.js` → matches only
   `26: return { exitCode: 0, ...` — the exit-0 return is now reachable only after a successful
   `readFileSync`; the exit-11 path is a thrown `err.exitCode = 11` (assignment, so not matched by the
   rg pattern). Expected shape confirmed.
2. `npm test -- --grep "read"` — not runnable as written: the repo's test runner
   (`tests/run-tests.js`) has no `--grep` flag. Ran the equivalent targeted files directly
   (`node tests/core/commands.test.js`, `node tests/core/result-persistence.test.js`), both green
   including the missing-artifact case.

**Deviations.** None from the ticket's scope. The zero-byte case (`result_bytes: 0` with a persisted
empty `result.md`) is covered by existing `result-persistence.test.js` as well; the missing-artifact
case that triggered this ticket (journal says done, no `result.md`) now exits 11 at both the
`executeRead` level and the CLI (`cli/dcli.js` top-level catch prints the message to stderr and exits
with `err.exitCode`).
