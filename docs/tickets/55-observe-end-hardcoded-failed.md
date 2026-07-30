# 55 — Observe-end terminal transition is hardcoded `failed`/exit 1, bypassing the reducer

**What to build:** when an adapter's `Observe` generator ends *without* yielding a `process_exited` fact (e.g. the stream closes, the adapter errors out, or the backend just stops producing), the engine currently hardcodes the journal transition to `to: 'failed', command_exit_code: 1` — never consulting the reducer. This direct-violates Invariant #2 ("Adapters emit facts; the engine decides state") and is the exact "Never trust a phase or progress signal as a completion signal" trap (`AGENTS.md` §1, Mistake #2). A real `done` outcome whose adapter stops emitting before `process_exited` is silently recorded as a fake failure.

**Blocked by:** None — can start immediately (coordinate with ticket 54, which touches the same `run.js` function for the hard-timeout default)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] In `core/commands/run.js` (around line 306-318), `core/commands/resume.js` (around line 380-393), and `core/commands/worker.js` (around line 404-419), the observe-end fallback calls `reduce(status, facts, {...})` and journals `result.state` (with `result.command_exit_code` where the reducer supplies one) — never a hardcoded `to: 'failed', command_exit_code: 1`.
- [ ] `core/commands/resume.js` and `core/commands/worker.js` import `reduce` from `../reducer` (currently only `run.js` does — confirmed by `grep "const result = reduce\("` returning one match).
- [ ] If the reducer returns a non-terminal state from facts that don't include `process_exited` (e.g. it returns `running` because no terminal evidence arrived), the engine journals `interrupted` (the `interrupted` state exists for exactly this case — see ticket 04), NOT `failed`.
- [ ] The reducer is updated if needed to derive a terminal state from "observe stream ended" + "no terminal fact arrived" → `interrupted` (or `failed` only when there is positive failure evidence, e.g. a `stream_closed { reason: 'error' }` fact). Coordinate with ticket 71 which also touches reducer ordering.
- [ ] Test: a fake adapter whose `Observe` yields `stream_closed` (no `process_exited`) ends in `interrupted`, not `failed`.
- [ ] Test: a fake adapter whose `Observe` yields nothing and just returns ends in `interrupted`, not `failed` with fake `command_exit_code: 1`.
- [ ] Test: a fake adapter yielding `process_exited {code: 0}` still resolves to `done` (this path already worked via `run.js:205`; protect it).
- [ ] Full suite green.

## Development guidance

- The `process_exited` path in `run.js:203-255` already does the right thing: it calls `reduce(status, facts, {})` at line 205 and uses `result.state` at line 207. Use that as the model. The bug is ONLY the observe-end fallback at lines 306-318 (and the identical blocks in resume.js and worker.js).
- The three command files have near-identical structure (`run.js`, `resume.js`, `worker.js`). Extract a shared `finalizeTerminalFromFacts({ store, jobId, repoKey, attemptNum, facts, collected, finalizeWorktreeSnapshot, adapter })` helper if you want, but it's optional — the priority is that all three sites call `reduce`.
- Do NOT change the `process_exited` path's existing reducer usage; that's the working model.
- Reducer changes: `core/reducer.js` rule order matters. If you add an "observe ended without terminal fact → `interrupted`" rule, place it AFTER every positive-evidence rule (after `process_exited` → `done`/`failed`, after `backend_error`) so it never overrides real evidence. See ticket 71 for the related `cancel_requested_at`-wins-over-completion ordering bug — fix both together or sequence carefully.
- The `collectResult` call at `run.js:306` should still run (we still want to persist whatever the adapter produced), but the *state decision* must come from the reducer, not from "we reached line 306".
- Watch the `hardTimedOut` branch immediately above the observe-end fallback (`run.js:286-304`): that path correctly journals `timed_out` because `hardTimedOut` is true there. Don't merge the two paths — they are distinct cases.

## Why it matters

A backend that produced a real result but died in a way that doesn't emit `process_exited` (network drop, adapter crash mid-stream, opencode SSE reconnect giving up) is recorded as a clean failure with a fake exit code. The user sees "failed, exit 1" when the assistant's answer is sitting in `result.md`. This is the documented worst-class bug: "A job holding a finished result while its process tree is alive is a real, observed condition."

## How to verify

```powershell
node tests/run-tests.js --suite full
```
Add a fake-adapter test where `behaviors.endWithoutProcessExited` causes `Observe` to return after yielding a `stream_closed` fact; assert the job ends `interrupted` and the result text is still persisted.

## Commit message

```
fix(core): observe-end terminal state via reducer, not hardcoded failed/exit 1
```