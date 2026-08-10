# 97 — One worker spawn path; the queued relaunch and the initial submit are two copies with different environments

**Status:** done
**Blocked by:** —
**Tier:** Correctness. Launch identity is what lets cancellation and reconciliation prove ownership —
ticket 84 exists because it was once not persisted. That code now exists twice, and the two copies pass
different environments.
**Filed from:** architecture review, 2026-08-10 (two of three reviewers independently).

---

## Symptom / Goal

A detached worker is spawned from two places:

- `core/commands/submit.js` — `spawnWorker()`, the initial submit. Environment:
  `DCLI_WORKER`, `DCLI_STATE_ROOT`, `DCLI_BACKEND`, `DCLI_JOB_ID`, `DCLI_REPO_KEY`, `DCLI_REPO_ROOT`,
  `DCLI_WORKER_HARD_TIMEOUT_MS`.
- `core/commands/worker.js` — inside the `setSpawnWorker` callback, the relaunch after a queue dequeue.
  Same environment **plus** `DCLI_QUEUE_CLAIM_PATH`. The stdio handling and the ordering of the
  `recordWorkerLaunch` call also differ.

Both must independently get right: the worker script path, the log handle, the environment, windowless
spawn on Windows, the execution token, and persisting launch identity *before* the child can run. A fix
to any of those that lands in one copy leaves the other path silently different — and the two paths are
"the job you submitted" and "the job that waited in the queue first", which no caller distinguishes.

Goal: one module spawns the worker; the queue claim becomes a parameter.

## Root cause

`setSpawnWorker` is a correct injection seam — the admission controller must not import `submit` — but
the spawn *body* was written into `worker.js` rather than into a module both callers import.

## Binding constraints — quoted, do not go looking for them

From `docs/design-spec.md` §7:

> | `18` | Worker launch / startup-sentinel failure |

From `docs/design-spec.md` §18a, "Windowless execution (Windows)": the detached worker must not flash a
console window. Whatever spawn options achieve that today must be preserved exactly — read the section
and the current options before changing anything.

From `docs/engineering/windows-spawning.md`: read it before touching this code. Argument arrays, never
shell strings; never `shell: true`.

Ticket 84 ("launch identity never persisted", done 2026-08-04) is the bug this consolidation prevents
recurring: launch identity must be persisted **before** the worker can start doing work, so cancel and
reconciliation can prove ownership. Read its Notes; do not weaken the ordering it established.

## Files to read and trace first

- `core/commands/submit.js` — `spawnWorker()`, the environment it builds, and where
  `recordWorkerLaunch` sits relative to the spawn.
- `core/commands/worker.js` — the `setSpawnWorker` callback; the second spawn, its stdio, and
  `DCLI_QUEUE_CLAIM_PATH`.
- `core/admission.js` — `setSpawnWorker`, `tryDequeue`, and what the callback is expected to return.
- `core/process-identity.js` — what constitutes launch identity and how it is verified later.
- `core/job-store.js` — `recordWorkerLaunch`.
- `tests/core/submit-launch-identity.test.js`, `tests/core/admission.test.js` — the regression net.

## What to build

### 1. `core/worker-spawn.js`

```js
spawnWorker({
  store, stateRoot, backend, jobId, repoKey, repoRoot,
  hardTimeoutSec, executionToken,
  queueClaimPath = null,
}) -> { child, launched }
```

It owns: worker script resolution, log handle, the full environment (with `DCLI_QUEUE_CLAIM_PATH` set
only when `queueClaimPath` is non-null), windowless detached spawn options, and the
`recordWorkerLaunch` call in its established order relative to the spawn.

### 2. Both call sites use it

`core/commands/submit.js` calls it with `queueClaimPath: null`. The `setSpawnWorker` callback in
`core/commands/worker.js` calls it with the claim path. Neither retains a spawn body.

### 3. Test the module, not the two commands

`tests/core/submit-launch-identity.test.js` targets `spawnWorker` directly, plus one end-to-end test per
call site proving the environment reaching the child is the expected one.

## Non-goals

- **Removing the `setSpawnWorker` injection seam.** It exists so `core/admission.js` does not import a
  command module; that is correct and stays.
- **Changing queue semantics, slot accounting, or the queued phase.** This ticket moves a spawn, nothing
  else.
- **Merging this into a larger scheduler module** that also owns slots, queue claims and reconciliation.
  One reviewer proposed it; it is a bigger redesign of `AdmissionController`'s interface and belongs in
  its own ticket if still wanted after this one lands.

## Acceptance criteria

- [ ] **A.** `core/worker-spawn.js` exists and is the only place `spawn` is called for a worker.
- [ ] **B.** `core/commands/submit.js` and `core/commands/worker.js` contain no spawn options object for
  the worker.
- [ ] **C.** The environment handed to the child is identical between the two call sites except for
  `DCLI_QUEUE_CLAIM_PATH`. Asserted by a test that captures the env from both paths and diffs them.
- [ ] **D.** Launch identity is persisted before the child can begin work, on both paths — ticket 84's
  ordering preserved, asserted by test.
- [ ] **E.** The spawn remains windowless and detached on Windows; no `shell: true`, no shell string.
- [ ] **Z.** `npm run check` green.

## Agent checks

```bash
# One worker spawn.
grep -rn "spawn(" core/commands/submit.js core/commands/worker.js
# expect: nothing — both delegate to core/worker-spawn.js

# The env keys live in one place.
grep -rn "DCLI_WORKER_HARD_TIMEOUT_MS\|DCLI_QUEUE_CLAIM_PATH" core/
# expect: core/worker-spawn.js (setting) and core/commands/worker.js (reading), not two setters

# No shell invocation.
grep -rn "shell: true\|cmd.exe /c" core/worker-spawn.js
# expect: nothing

npm run check
# expect: green
```

## Handoff

**Extra reading, beyond `AGENTS.md` and `00-onboarding.md`** — `docs/engineering/windows-spawning.md`
(all of it; this ticket is entirely process creation), `docs/design-spec.md` §18a (windowless
execution), and **ticket 84's Notes** (`84-launch-identity-never-persisted.md`). Nothing else.

**Implementation order:**

1. Write the env-diff test first (criterion C): capture the environment object each of the two spawn
   sites builds, and assert they differ only by `DCLI_QUEUE_CLAIM_PATH`. Verify it **fails today** —
   that failure is the ticket's evidence, so record its output in Notes.
2. Create `core/worker-spawn.js` by **moving** `submit.js`'s `spawnWorker` verbatim, then adding the
   optional `queueClaimPath` parameter.
3. Point `submit.js` at it with `queueClaimPath: null`. Suite green.
4. Point the `setSpawnWorker` callback in `worker.js` at it with the claim path. Suite green; the env-diff
   test from step 1 now passes.
5. Reconcile the stdio handling and the `recordWorkerLaunch` ordering. **Take `submit.js`'s ordering**
   unless a test proves the worker's is required — that is the ordering ticket 84 established and
   tested.

**Running tests while you work:**

```bash
node tests/core/submit-launch-identity.test.js
node tests/core/admission.test.js
npm run check
```

**Traps specific to this ticket:**

- Launch identity must be persisted **before** the child can begin work. If you move
  `recordWorkerLaunch` after the spawn, cancellation and reconciliation lose the ability to prove
  ownership — that is ticket 84's bug, exactly.
- Windowless spawn on Windows depends on the current spawn options. Copy them verbatim; do not
  "simplify" `detached`, `windowsHide`, or the stdio array.
- Never `shell: true`, never a command string. Argument arrays only.
- The log handle is a real file descriptor. If both call sites open it, make sure the module opens it
  once and that a spawn failure closes it — a leaked handle keeps the worker log locked on Windows.
- Keep `setSpawnWorker` as the injection seam. `core/admission.js` must not import a command module.

**Commit message:**

```
ticket 97: one worker spawn path for submit and queued relaunch
```

## Notes

(Left empty by the author.)

## Notes — 2026-08-10 implementation

**env-diff evidence (criterion C, "fails today").** The env-diff test targets `core/worker-spawn.js`
directly, so today it failed at module load: `Cannot find module '../../core/worker-spawn'`
(`MODULE_NOT_FOUND`, tests/core/worker-spawn.test.js). The two existing spawn bodies' envs were
already byte-identical except `DCLI_QUEUE_CLAIM_PATH` — as the handoff suspected after tickets 92/95,
so no env *value* diverged; the divergence was structural: the worker path always set
`DCLI_QUEUE_CLAIM_PATH` (to `''` when the claim was absent — never exercised, since admission only
invokes the callback with a real claim path), the submit path never set it. The module now sets it
only when `queueClaimPath !== null`, and `tests/core/worker-spawn.test.js` asserts the captured child
envs (via NODE_OPTIONS preload) differ by nothing but that key, with `DCLI_JOB_ID` excluded from the
diff as a per-job key, not a per-call-site one.

**stdio/ordering decision (ticket handoff step 5).** Took `submit.js`'s ordering verbatim, as
directed: spawn → `recordWorkerLaunch` (identity persisted before the child can begin work, ticket 84)
→ wait for the `spawn` event (bounded 1 s) with `error` journaling `worker_spawn_failed` → `unref`.
This is also the ordering the queued path now inherits. Two consequences worth recording:

- The queued relaunch previously attached **no** `error` listener to its child — an asynchronous spawn
  failure would have surfaced as an unhandled `error` event and crashed the hosting worker process.
  The module's handler now covers both call sites (queued-path spawn failures journal
  `worker_spawn_failed`; the `from: 'created'` in that journal entry is submit's original body,
  carried verbatim — for a queued job the reducer ignores it, since reconciliation only decides for
  `running`/`created` states, reducer.js:148).
- `recordWorkerLaunch`'s `from` field follows the call site: `queueClaimPath !== null` → `'queued'`,
  else `'created'`. Derived from the parameter rather than carried as a second param; asserted by test
  (journal line contains `"from":"queued"` on the queued path).

**hardTimeoutSec round-trip.** The queued callback passes `entry.hardTimeoutMs / 1000`; the module
recomputes `× 1000` and stringifies. For integer millisecond values (the only ones enqueued —
`parseInt` of the env var) the round trip is exact in IEEE-754 for all values < 2^53, so
`DCLI_WORKER_HARD_TIMEOUT_MS` is byte-identical between paths.

**Spawn options copied verbatim** from submit.js: `detached: true`, `windowsHide: true`,
`stdio: ['ignore', workerLog, workerLog]`, argument array `[workerScript]`, never `shell: true`.
Criterion E rests on the verbatim copy plus the Agent-check greps (`spawn(` absent from both
commands, no `shell: true`/`cmd.exe /c` in the module) — no window-visibility detector is run here;
none existed for the previous spawn sites either.

**Return shape.** `{ child, launched }`. submit awaits `launched`; the worker.js callback is
synchronous (admission does not await it), so it calls the module fire-and-forget — the module owns
`unref`, the failure journaling, and the log handle (opened once, closed in `finally` after spawn,
failure or not — no leaked handle to lock worker.log on Windows).

**Discovery.** Journal entries are compact JSON (`"from":"queued"`, no space after the colon);
an early assertion with spaced keys failed. Also: `getProcessStartTime` on a pid that has just exited
prints a pwsh "null-valued expression" error to the test's stderr — pre-existing production noise from
`workerIdentityDetail`, not a failure (tests pass with exit 0; the first capture variant held the child
alive 300 ms before exit to avoid it where practical).

**Tests.** `tests/core/worker-spawn.test.js` (new, `@suite full`/`@serial`): (1) module env-diff,
criterion C; (2) queued-path identity-before-work ordering with a blocked child, criterion D; (3) real
end-to-end queued relaunch — a live worker finishes, `releaseSlot` dequeues a seeded queue entry, the
`setSpawnWorker` callback spawns the replacement through the module, and that child receives
`DCLI_QUEUE_CLAIM_PATH` pointing at a `.launching-*` claim and runs the queued job to `done`.
`tests/core/submit-launch-identity.test.js` (submit-path e2e, unchanged) and
`tests/core/admission.test.js` stay green; `npm run check` green.
