# 29 — `submit` actually launches a background worker

**Blocked by:** None — can start immediately
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` §"The five invariants" #2–#3,
mistake #1 ("An unbounded wait cost a user eight hours") and mistake #5 ("Launch identity must be
persisted *before* it can be lost").

---

## Purpose

`dcli-<backend> submit` must actually start the backend job in the background. Today it does not.

## Why it matters

This is the single most severe defect found in review: **background delegation, the primary reason this
tool exists, does not work.** A user who runs `submit` gets a job ID and a `created` status forever. A
subsequent `wait --all --group` will time out. The prompt the user typed is silently discarded — it is
never persisted or handed to any process. This is invisible until someone actually tries the async path,
because `run` (synchronous) works fine and is what every earlier ticket's manual verification used.

## Evidence (verified live on this machine)

```
node cli/dcli-codex.js submit --repo . --prompt-file <file> --hard-timeout-sec 1800 --group g --json
# → {"state":"created", ...}
node cli/dcli-codex.js wait --repo . --group g --all --timeout-sec 1800 --json
# → returns immediately with the job still "created" — nothing ever ran
```

`core/commands/submit.js` calls `store.createJob(...)` and, if admission denies a slot, journals a
`queued` transition — and returns. There is no `spawn`, no `attempt_created` transition, no prompt
persistence anywhere in the function or its caller (`cli/dcli.js` `case 'submit'`).

## Design

- After `store.createJob(...)` succeeds (and admission grants or the job is queued for later dispatch),
  **persist the prompt** to the job's attempt directory so a detached worker can read it without relying
  on the parent process's memory.
- Launch a **detached, contained** worker process (reuse the same containment helper used for `run`) whose
  job is: read the persisted prompt, call the adapter exactly as `run` does, and journal transitions
  (`attempt_created` → `running` → terminal) as it goes. It must not require the `submit`-invoking process
  to stay alive.
- **Persist launch identity (pid + creation time + image path + execution token) synchronously**, before
  the worker can do anything meaningful — this is the exact failure class in AGENTS.md mistake #5. Do
  this even before the worker starts its own work, so a crash between spawn and first heartbeat still
  leaves provable identity behind for reconciliation.
- Bound the process-creation call itself (mistake: "a wedged process-creation provider hung `submit`
  before its anti-hang window began").
- No console window may ever appear (`windowsHide: true` on every spawn; the native containment helper
  must pass `CREATE_NO_WINDOW`, never `CREATE_NEW_CONSOLE`).
- If admission denies a slot and the job is queued, the **eventual dequeue must itself launch a worker**
  (see ticket 36) — do not consider a job "submitted" until it either launches immediately or is durably
  queued with a real path to later launch.
- `wait`/`status`/reconciliation already understand `created` → `running` → terminal transitions (per
  ticket 04); this ticket only needs to make the *launch* real, not redesign the state machine.

## Pitfalls

- Do not make `submit` block until the worker's first heartbeat in a way that reintroduces synchronous
  behavior — the whole point is the calling process can exit immediately. Persist identity, then return.
- Do not skip startup-sentinel reconciliation: if the worker never reaches `running` within a bounded
  window, a later `status`/`wait` call must be able to tell the difference between "still starting" and
  "died before it could report."
- Do not regress `run` (synchronous) — it must continue to work exactly as today; this ticket only touches
  the `submit` path.

## Checklist

- [ ] `submit` persists the prompt durably (not just in the invoking process's memory).
- [ ] `submit` launches a real detached, contained, windowless worker (or durably queues one — see ticket 36).
- [ ] Launch identity (pid, creation time, image path, execution token) is persisted synchronously right
      after process creation, before any other work.
- [ ] A job created via `submit` reaches `running` and eventually a terminal state without any other CLI
      invocation staying alive.
- [ ] `wait --all --group` on a `submit`-created job actually completes (not just times out).
- [ ] The worker never displays a console window (verified via the window-visibility test approach in
      AGENTS.md "No console window, ever", not by checking for absence of `conhost.exe`).
- [ ] Process-creation itself is bounded by a timeout distinct from the job's hard timeout.
- [ ] A regression test exercises `submit` end-to-end against the fake adapter and asserts the job reaches
      a terminal state without the test ever calling `run` or manually advancing state.

## How to verify

```powershell
node tests/run-tests.js --suite full
node cli/dcli-codex.js submit --repo . --prompt-file <file> --hard-timeout-sec 60 --group t1 --json
node cli/dcli-codex.js wait --repo . --group t1 --all --timeout-sec 90 --json   # must report done, not timed_out
```

## Definition of done

Full suite green; a `submit`-created job for every backend (including `fake`) reaches a terminal state
without any other process staying alive, and `wait --all` observes it.

## Commit message

```
fix: submit dispatches a real detached worker instead of only recording intent
```

## Verification 2026-07-29 — appears FIXED on this machine

Re-ran this ticket's own evidence commands against real backends. The reported defect no longer
reproduces; see the run below. Status left as-is for the ticket owner to close, since this was a
verification pass and not an implementation of this ticket.

```
node cli/dcli-codex.js submit --repo . --prompt-file <f> --hard-timeout-sec 180 \
  --group t29probe --access read-only --json
# → {"state":"created", "job_id":"20260729T091530Z-ifv2i9th"}
node cli/dcli-codex.js wait --repo . --all --group t29probe --timeout-sec 200 --json
# → {"jobs":[{"job_id":"20260729T091530Z-ifv2i9th","state":"done","phase":"terminal"}]}
node cli/dcli-codex.js read 20260729T091530Z-ifv2i9th --repo .
# → pong
```

A detached worker ran, the prompt was persisted (`prompt.txt` is present in the job directory rather
than discarded), and `wait --all --group` found the job instead of timing out. `core/commands/worker.js`
and the prompt/params persistence in `core/commands/submit.js` are the implementation.
