# 98 — Split `core/commands/index.js`: five unrelated subjects in one file every module imports

**Tier:** AI-navigability and testability. The file has no subject, so every change anywhere lands in
it — it is one of the repository's three hottest files. An agent looking for the exit-code contract has
to scroll past three flag tables to find it.
**Filed from:** architecture review, 2026-08-10 (two of three reviewers independently).

---

## Symptom / Goal

`core/commands/index.js` is 576 lines and exports thirteen symbols spanning five unrelated concerns:

| Concern | Roughly |
|---|---|
| Job lookup — `loadJobOrThrow` | `:15-76` |
| Terminal-outcome policy — `classifyTerminalFailure`, `terminalExitCode`, `FAILURE_EXIT_CODES` | `:141-182` |
| Envelope shape — `buildEnvelope` | `:204-221` |
| Argument parsing and validation — `parseArgs`, `validatePositionals`, the flag tables | `:78-129`, `:224-463` |
| Bounded stdin reading — `resolvePrompt`, `readStdinBounded` | `:465-532` |
| Semver comparison — `compareVersions`, `isVersionInRange` | `:534-551` |
| Adapter disposal — `tryDisposeAdapter` | `:553-574` |

The name `index` implies a barrel; it is a grab-bag. Every command module, `cli/dcli.js` and the worker
import from it, so it is on every dependency path and every diff.

`KNOWN_FLAGS` (`:78-89`) is exported and **has no consumer** — the parser uses `BOOL_FLAGS` and
`VALUE_FLAGS` instead, and the three lists must be kept in sync by hand. `compareVersions` has exactly
one consumer, `prepareBackend` in `core/commands/attempt.js`.

Goal: each subject in a file named for it, so an agent can find the contract it needs, and each gets its
own test suite instead of everything being exercised through the 1300-line `tests/core/commands.test.js`.

## Root cause

The file was the natural landing place for anything shared between commands, and nothing ever pushed a
subject out of it.

## Binding constraints — quoted, do not go looking for them

From `docs/design-spec.md` §7, on the job-lookup semantics that move with `loadJobOrThrow`:

> A directory that exists but whose record cannot be read is **`17`**, not `3` — exit 3 tells an agent
> to stop looking. `resume`, `submit --resume`, `diff` and `apply` each had their own catch-all mapping
> every read failure to `3`; they all go through `loadJobOrThrow()` now.

That last sentence is the reason `loadJobOrThrow` must stay a single shared function with every current
caller intact. Moving it must not give anyone an excuse to re-inline it.

From `docs/engineering/naming-contracts.md`: the new file names are not persisted or parsed, so they are
not contracts — but pick names that describe the subject, not the layer.

Invariant 4 (append-only) applies to everything that moves: **no exit code, envelope field or error
message text changes in this ticket.**

## Blocked by ticket 93

Ticket 93 moves `classifyTerminalFailure`, `terminalExitCode` and `FAILURE_EXIT_CODES` into
`core/failure-class.js`, so the exit-code contract lands in its own reviewable commit. Start this ticket
after 93 is green; the terminal-outcome row above will already be gone.

## Files to read and trace first

- `core/commands/index.js` — the whole file.
- Every importer: `core/commands/attempt.js`, `core/commands/worker.js`, `run.js`, `resume.js`,
  `submit.js`, `wait.js`, `read.js`, `status.js`, `tail.js`, `debug.js`, `diff.js`, `apply.js`,
  `cancel.js`, `review.js`, `cli/dcli.js`. Trace what each actually uses — several import the barrel for
  one symbol.
- `tests/core/commands.test.js` — 1300 lines exercising everything through the barrel; this is where
  the split pays off.
- `scripts/generate-integration.js` — it maintains its own command list. Confirm whether it imports
  anything from `index.js`; if it does, the move must not break the generated-skills gate.

## What to build

### 1. `core/cli-args.js`

`parseArgs`, `validatePositionals`, `resolvePrompt`, `readStdinBounded`, `maybeAccessHint`, and the flag
tables. Interface: `parseArgs(argv) -> ParsedInvocation`.

### 2. `core/job-lookup.js`

`loadJobOrThrow`, unchanged in behaviour, with its exit-3 / exit-17 semantics and their explanatory
comment.

### 3. `core/envelope.js`

`buildEnvelope` and `NO_RESULT_BYTE_THRESHOLD`. (If ticket 93's `core/failure-class.js` turns out to be
the better home for the threshold, put it there and say so in Notes — but pick one.)

### 4. Demote the two single-consumer helpers

`compareVersions` and `isVersionInRange` become private to `core/commands/attempt.js` (or to the attempt
driver, if ticket 92 landed first). `tryDisposeAdapter` moves to the same place — it is part of ending
an attempt.

### 5. Delete `KNOWN_FLAGS`

It is exported and unused. If removing it reveals that it was meant to be the parser's validation set,
that is a finding: record it in Notes and file a follow-up rather than wiring it up here.

### 6. `core/commands/index.js` either disappears or becomes a real barrel

A barrel that only re-exports is acceptable if it keeps the diff small; a file that still defines
anything is not.

### 7. Split the test suite

One suite per new module. `tests/core/commands.test.js` keeps only what genuinely spans commands.

## Non-goals

- **Restructuring `cli/dcli.js`'s dispatch switch, or building a command catalog** shared with
  `scripts/generate-integration.js`. Real friction, but stdout bytes and exit codes are the contract for
  agent callers, so it needs golden tests captured first and belongs in its own ticket.
- **Changing any parsing behaviour, error message or exit code.** Pure moves.
- **Renaming `getBackground()` in `adapters/registry.js`.** Noted as a poor name during review; it is
  not in this file and not worth coupling to this change.

## Acceptance criteria

- [ ] **A.** `core/commands/index.js` defines nothing; it either no longer exists or only re-exports.
- [ ] **B.** `KNOWN_FLAGS` does not appear anywhere in the repository.
- [ ] **C.** `compareVersions`, `isVersionInRange` and `tryDisposeAdapter` are not exported from any
  shared module; each has exactly one consumer, in the same file.
- [ ] **D.** Each new module has its own test file, and `tests/core/commands.test.js` is materially
  smaller.
- [ ] **E.** Every CLI error message and exit code is unchanged. Verified by a byte-comparison of the
  CLI output for a fixed set of invalid invocations, captured before the change.
- [ ] **Z.** `npm run check` green, including the generated-skills gate.

## Agent checks

```bash
# Nothing is defined in the old file.
grep -nE "^(function|const|class) " core/commands/index.js
# expect: nothing, or the file is gone

# The dead export is gone.
grep -rn "KNOWN_FLAGS" .
# expect: nothing

# Single-consumer helpers are no longer shared.
grep -rn "compareVersions\|tryDisposeAdapter" core/ cli/
# expect: definitions and uses confined to one file each

npm run check
# expect: green
```

## Handoff

**Check your blocker first.** Ticket 93 must be `done` in [`README.md`](README.md). If it is not, stop
and say so — this ticket assumes the terminal-outcome symbols have already left the file.

**Extra reading, beyond `AGENTS.md` and `00-onboarding.md`** — `docs/design-spec.md` §7 (the exit-3 /
exit-17 paragraph quoted above) and `docs/engineering/naming-contracts.md`. Nothing else.

**Implementation order.** This is a pure move, so the safety net comes first:

1. **Capture golden CLI output before touching anything.** Pick a fixed set of ~15 invalid and valid
   invocations (bad flag, bad `--mode`, missing job id, malformed job id, `--json` variants of each).
   Record stdout, stderr and exit code for each into a fixture. Criterion E is a byte comparison against
   this. Commit the fixture in the same commit.
2. Move one subject at a time, running `npm run check` after each: `core/cli-args.js`, then
   `core/job-lookup.js`, then `core/envelope.js`.
3. Demote `compareVersions`, `isVersionInRange` and `tryDisposeAdapter` into their single consumers.
4. Delete `KNOWN_FLAGS`. If the suite still passes, it was dead as claimed — record that in Notes.
5. Reduce `core/commands/index.js` to re-exports, or delete it and update every importer.
6. Split `tests/core/commands.test.js` last, once the modules are stable.

**Running tests while you work:**

```bash
node tests/core/commands.test.js
node tests/integration/generate.test.js   # the generated-skills gate
npm run check
```

**Traps specific to this ticket:**

- **Move, do not rewrite.** Every function body is transplanted unchanged. If you find a bug while
  moving, write it into Notes and file a follow-up — fixing it here makes the golden comparison
  meaningless, which destroys the only proof this refactor was safe.
- `loadJobOrThrow` must keep every current caller. §7 records that `resume`, `submit --resume`, `diff`
  and `apply` each once had their own catch-all mapping read failures to `3`; they all go through this
  one function now, and that must stay true.
- `scripts/generate-integration.js` maintains its own command list. If it imports anything from
  `core/commands/index.js`, the generated-skills gate will fail — check before you delete the barrel.
- Error message **text** is part of what agents parse. A moved message must be byte-identical.

**Commit message:**

```
ticket 98: split core/commands/index.js by subject
```

## Notes

(Left empty by the author.)
