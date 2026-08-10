# 97 — One worker spawn path; the queued relaunch and the initial submit are two copies with different environments

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
