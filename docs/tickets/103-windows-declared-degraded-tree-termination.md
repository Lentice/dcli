# 103 — Windows: a declared-degraded tree termination that names its survivors

**Status:** blocked
**Blocked by:** 102
**Tier:** Trust, and the riskiest ticket in the ladder. This adds a mechanism that *could* claim a kill it
cannot verify — which is exactly the failure mode the whole containment record was built to prevent. It is
worth doing because it buys most of the outcome of the Job Object at a fraction of the cost, and it is
only worth doing if it is honest about what it did not reach.
**Filed from:** the containment review of 2026-08-10 that produced ADR-010. Rung 2 of its ladder.

---

## Symptom / Goal

On Windows, `dcli cancel` and `--hard-timeout-sec` reach the backend's direct child only
(`child.kill('SIGKILL')`, which Node maps to `TerminateProcess`). Every descendant survives: opencode's
watchers and providers, a test runner the backend started, a `git` it left running. The record is honest
about this — `kill_skipped: 'not_contained'`, `cancel_rung_reached: 'containment_unavailable'` — but the
survivors are real, and a survivor holding a lock, a port, or a worktree blocks the next job.

`docs/design-spec.md` §14 already sanctions the fallback; nothing has ever built it.

Goal: on Windows, terminate the enumerated descendant set, **verify** the result against that same set, and
report precisely what is still alive.

## Binding constraints — quoted, do not go looking for them

From `docs/design-spec.md` §14, which already specifies this exact mechanism as the fallback:

> If assignment fails (already in a non-breakaway job), fall back to verified descendant enumeration
> plus `taskkill /T /F`, **record `containment.degraded = true`**, and test that path explicitly.

> `taskkill`-based cleanup is a **declared degraded capability** recorded in the job record — never a
> transparent fallback.

> **Never** kill by executable name or by an unverified reused pid. OS process identity is
> `pid + creation time + image path` — but that only reduces PID-reuse mistakes, it does not *prove
> ownership*.

From **ADR-010**, which is the reason this ticket may exist at all — read the whole entry:

> Rung 2 in particular introduces a mechanism that *could* claim success it cannot verify — a descendant
> spawned between enumeration and termination escapes, and pid reuse is reduced by `pid + creation time +
> image path` but never disproved (ADR-008). So rung 2 must verify against its own enumerated set and
> report the survivors, ending in exit 21 with a named survivor set rather than a clean cancellation.
> Reporting uncertainty is always preferable to reporting a kill.

From `docs/design-spec.md` §7, the exit code this ticket produces on an incomplete kill:

> | `21` | Cancellation could not be confirmed |

Invariant 4 is append-only: exit 21 keeps its meaning, `containment.degraded` keeps its meaning, and no
existing field is repurposed. Anything new is a **new** field.

From `AGENTS.md`: "Argument arrays, never shell strings. No `cmd.exe /c`, no `/bin/sh -c` for ordinary
invocation, and never `shell: true`." `taskkill` is invoked as an argument array, with `windowsHide: true`
and a finite timeout (invariant 3).

## Blocked by ticket 102

102 introduces `terminateProcessTree(child, { graceMs })` in `adapters/shared/process-lifecycle.js` with a
Windows branch that is today's direct-child kill. This ticket replaces **only that branch**. Starting before
102 lands means writing the seam twice and reviewing the two platforms in one diff.

## Files to read and trace first

- `adapters/shared/process-lifecycle.js` — `terminateProcessTree` as ticket 102 leaves it. The Windows
  branch is the entire edit surface for termination.
- `core/commands/worker.js` — the hard-timeout timer, `hardTimeoutKillSkipped = 'not_contained'`, and the
  comment above it explaining why the escalation is skipped. That comment stops being true on Windows.
- `core/commands/cancel.js` — the rung walk, the postcondition check, and where exit 21 is produced.
- `core/process-identity.js` — how `pid + creation time + image path` is already captured and compared. This
  ticket must reuse it, not invent a second identity notion.
- `core/containment.js` — read it to confirm what you are **not** touching: it is the Job Object helper
  client (rung 3), and it stays unconstructed.
- `docs/engineering/windows-spawning.md` — required before any process work on Windows.
- `tests/fixtures/grandchild-pipe.js` — the existing precedent for a fixture that spawns a descendant.
- `docs/tickets/91-containment-test-headless-safe.md` — how a containment test is kept green without a
  desktop, and why a silently-skipped test is not coverage.

## What to build

### 1. Enumerate the descendant set, with identity

A Windows-only module under `adapters/shared/` (or `core/` only if it holds no backend knowledge at all —
invariant 1 applies either way):

```js
enumerateDescendants(rootPid) -> Array<{ pid, parentPid, createdAt, imagePath }>
```

Walk the parent-pid graph from `rootPid`. Capture `pid + creation time + image path` for each entry using
`core/process-identity.js`'s existing notion. Bounded: a finite depth cap, a finite node cap, and a finite
overall deadline. Record the cap in the result if it was hit — a truncated enumeration is reduced coverage
and must be announced, never silently accepted.

### 2. Terminate, then verify against that exact set

```js
terminateTree(rootPid, { deadlineMs }) -> {
  kind: 'taskkill-tree',
  degraded: true,
  attempted: [...pids],
  confirmedDead: [...pids],
  survivors: [{ pid, imagePath, reason }],
  enumerationTruncated: boolean,
}
```

- `taskkill /PID <rootPid> /T /F`, as an argument array, `windowsHide: true`, finite timeout.
- Then re-check **every pid in `attempted`**. A pid is `confirmedDead` only when it is gone, **or** when a
  process with that pid exists but its creation time and image path no longer match what was enumerated
  (that is pid reuse — the original is dead).
- A pid still alive **and still matching** its recorded identity is a `survivor`.
- Anything discovered after enumeration is out of scope by construction — that is the race ADR-010 names,
  and it is why `degraded` is permanently `true`.

### 3. Report it, and let it decide the exit code

- Job record: `containment: { kind: 'taskkill-tree', degraded: true }`, plus a new field naming the
  survivors. Do not overload an existing field.
- Cancel with a non-empty `survivors` → **exit 21**, with the survivors named in the human output and in the
  JSON envelope. Not exit 0. Not a `cancelled` state claiming a clean kill.
- Hard timeout with a non-empty `survivors` → the `timed_out` detail records the survivors instead of
  `kill_skipped: 'not_contained'`. `kill_skipped` is only correct when no kill was attempted; once one is,
  writing it is a second, different lie.
- Empty `survivors` → the rung succeeded, and the record still says `degraded: true`, because the mechanism
  cannot prove there was nothing outside the enumerated set.

### 4. Tests — the point of the ticket

- A fixture with a **grandchild** and a great-grandchild: all gone after the rung, `survivors` empty.
- **The survivor path, explicitly.** Force a process that `taskkill` cannot end and assert the result names
  it, the cancel exits 21, and the state is not a clean `cancelled`. §14 says "test that path explicitly";
  a mechanism that has only ever been tested succeeding is exactly the one that will lie in production.
- Pid reuse: a recorded pid now belonging to a different image is `confirmedDead`, not a survivor.
- Enumeration truncation is reported rather than swallowed.
- Non-Windows platforms skip visibly (ticket 91's pattern) and rung 1 is untouched.

## Non-goals

- **The Job Object helper (rung 3, ticket 78).** Closed by decision, and ADR-010 reopens it only on evidence
  that *this* rung shipped and proved insufficient. Do not construct `ContainmentContext`, do not extend the
  helper protocol, do not add stdin forwarding to it.
- **Kill-on-close / surviving worker death.** Only a Job Object gives that. ADR-008's non-promise stands.
- **Killing by executable name, or by a pid whose identity does not match what was enumerated.** §14 forbids
  it outright, and it is how a tool kills an unrelated process on a busy machine.
- **Any change to the Unix path.** 102 owns it.
- **Adding or renaming a cancel rung.** ADR-007: the adapter declares them. `hard_kill` changes what it does.

## Acceptance criteria

- [ ] **A.** On Windows, a test proves a grandchild **and** a great-grandchild of the backend are dead after
  the `hard_kill` rung.
- [ ] **B.** A test forces a survivor and asserts: it is named in the result, `dcli cancel` exits **21**, and
  no clean `cancelled` outcome is reported.
- [ ] **C.** Verification compares `pid + creation time + image path` against the enumerated set; a reused pid
  counts as dead, and no process outside the enumerated set is ever signalled.
- [ ] **D.** The job record carries `containment: { kind: 'taskkill-tree', degraded: true }` and the survivor
  set. `degraded` is `true` even when nothing survived.
- [ ] **E.** `taskkill` is invoked as an argument array with `windowsHide: true` and a finite timeout. No
  `shell: true`, no command string, anywhere.
- [ ] **F.** Enumeration is bounded in depth, node count and time, and a truncated walk is reported.
- [ ] **G.** `kill_skipped: 'not_contained'` no longer appears on Windows once a kill was attempted.
- [ ] **H.** The Unix rung-1 path from ticket 102 is unchanged; non-Windows tests skip visibly.
- [ ] **Z.** `npm run check` green; `README.md`, `docs/design-spec.md` §14, ADR-010's ladder table and
  `integration/source/core.md` updated in the same commit, then `node scripts/generate-integration.js`
  re-run and the generated skills committed.

## Agent checks

```bash
# No shell invocation.
grep -rn "shell: true\|cmd.exe /c\|/bin/sh -c" adapters/ core/
# expect: nothing

# taskkill is an argument array with a bounded call.
grep -rn "taskkill" adapters/ core/
# expect: one call site, args as an array, windowsHide: true, a finite timeout

# Never kill by name.
grep -rniE "taskkill.*\/IM|/IM " adapters/ core/
# expect: nothing — /PID only

# Rung 3 stays unconstructed (ticket 78 is closed).
grep -rn "new ContainmentContext" core/ adapters/ cli/
# expect: nothing

# The degraded flag is not optional.
grep -rn "degraded" core/ adapters/
# expect: 'taskkill-tree' is always accompanied by degraded: true

npm run check
# expect: green
```

## Handoff

**Check your blocker first.** Ticket 102 must be `done` in [`README.md`](README.md). If it is not, stop and
say so — this ticket edits a function 102 creates.

**Extra reading, beyond `AGENTS.md` and `00-onboarding.md`** — **ADR-010** in
`docs/architecture-decisions.md` (all of it, especially "The line that does not move"),
`docs/design-spec.md` §14 including both amendments, ADR-008 on ownership proof,
`docs/engineering/windows-spawning.md`, and **ticket 91's Notes**. Nothing else.

**Read this before you start.** This is the one ticket in the batch where a plausible, working, green
implementation can still be wrong. `taskkill /T /F` will usually appear to succeed. The value of this
ticket is entirely in the verification step and the survivor report — an implementation that kills the tree
but skips criterion B has made the tool *less* trustworthy than the rung-0 state it replaced, because
rung 0 at least never claimed anything. If you run short of time, ship the verification and report a
survivor set you could not reduce; do not ship an unverified kill.

**Implementation order:**

1. Build `enumerateDescendants` and test it alone against a fixture tree three levels deep. No killing yet.
2. Build the verification step against a tree you kill **by hand** in the test. Prove it reports survivors
   correctly before anything automatic can hide the bug.
3. Only then wire `taskkill`, and only through the seam ticket 102 created.
4. Add the forced-survivor test (criterion B). If you cannot construct a survivor reliably, inject the
   enumeration/verification results in the test rather than skipping the case — the path must be covered.
5. Thread the record and exit 21 through `core/commands/cancel.js` and `core/commands/worker.js`.
6. Update the docs and re-run the generator.

**Running tests while you work:**

```bash
node tests/contract/suite.js
npm run check
```

**Traps specific to this ticket:**

- **A green kill test is not evidence.** The survivor path is the one that matters and the one §14 names.
- **Pid reuse cuts both ways.** A pid that is alive but no longer matches its recorded identity is
  `confirmedDead`, not a survivor — and a pid you never enumerated must never be signalled, whatever it
  looks like.
- **`taskkill` exit codes are not a verdict.** It reports success for processes it merely *asked* to end,
  and non-zero for a pid already gone. Decide from the re-check, never from its exit code.
- **The enumeration/termination race is permanent.** A descendant born between the two escapes. That is why
  `degraded` is `true` unconditionally — do not "improve" it to `false` when nothing survived.
- **`kill_skipped` becomes wrong the moment a kill is attempted.** Replace it on Windows; do not keep
  writing it alongside a real attempt.
- Never `shell: true`, never a command string, and `windowsHide: true` on every `taskkill`.
- Do not touch `core/containment.js`. Rung 3 is closed and reopening it is an ADR-010 decision, not an
  implementation detail of this ticket.

**Commit message:**

```
ticket 103: windows terminates the backend tree as a declared degraded capability
```

## Notes

(Left empty by the author.)
