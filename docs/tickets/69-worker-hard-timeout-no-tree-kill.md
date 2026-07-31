# 69 — Worker hard-timeout never kills the backend process tree; the tree survives after `timed_out`

**What to build:** the worker's hard-timeout timer — when `cancelThroughRungs` walk fails or the adapter ignores the cancel signal — escalates to `containment.terminate(...)` to provably kill the backend process tree, not just ask politely. Today `worker.js`'s hard-timeout calls `requestCancelRungs()` (rung walk) then journals `timed_out` and `process.exit(24)` — the backend process tree (the one with the real孙子 processes holding stdin/stdout pipes) keeps running outside any Job Object, holding resources and locks until the OS reaps it. This is exactly the incident that started the predecessor's "`AGENTS.md` §1: unbounded wait cost a user eight hours."

**Blocked by:** Ticket 55 (both touch the worker terminal/journal paths — sequence 55 first so the reducer drives state, then 69's kill-on-hard-timeout uses that state). **Also blocked by ticket 78** — see the amendment below.

**Status:** partially landed 2026-07-31 (honesty half done); the kill itself is blocked on ticket 78

## Amendment 2026-07-31 — the kill this ticket asks for is not implementable as written

Investigated while picking this ticket up. **The premise "call `containment.terminate(backendProcessIdentity)`
— the same helper `core/cancel.js:80-86` uses" is false in two ways**, so the acceptance criteria below cannot
be met by editing `worker.js`:

1. **`core/cancel.js`'s containment branch never runs on a real job.** `core/commands/cancel.js:36` passes
   `containment: null` hardcoded, and nothing anywhere in `core/`, `adapters/` or `cli/` ever constructs a
   `ContainmentContext`. There is no working precedent to copy.
2. **The backend tree is not contained, and cannot be contained after the fact.** All three adapters plain-`spawn`
   the backend (`adapters/claude/adapter.js:240`, `adapters/codex/adapter.js:354`,
   `adapters/opencode/adapter.js:824`), so it is in no Job Object. The native helper has exactly two commands,
   `spawn` and `terminate`, and `terminate` only acts on the Job Object that helper instance created itself —
   `HandleTerminate` answers `{"type":"error","error":"no active job"}` when `_jobHandle` is zero. A Windows Job
   Object cannot adopt a running tree. There is no `terminate-by-pid` capability to call.

An in-progress `terminateTree(pid)` found uncommitted in the working tree demonstrated the trap: it launched the
helper with the pid as **argv** (which the helper never reads), then resolved `{terminated: true}` off the
helper's exit code *after* the helper had already answered with an error — reporting a successful kill having
killed nothing, i.e. AGENTS.md Mistake #5 verbatim. It was removed rather than repaired, and
`tests/core/hard-kill-honesty.test.js` test 4 now pins its absence.

**Decision (2026-07-31, with the maintainer): take the route with the least long-term debt** — contain the tree
at spawn time, which is what `docs/2026-07-28-design-spec.md` §14 already specifies and which was simply never
implemented. That work is **ticket 78**, itself blocked on ticket 60 (the helper discards child-stdin data, and
codex/claude deliver the prompt over stdin).

### Landed in this ticket (commit: honesty half)

- `core/containment.js`: the bogus `terminateTree` is gone, replaced by a comment explaining why a pid-based
  tree kill cannot work against today's helper.
- `core/commands/worker.js`: the hard timeout records `kill_skipped: 'not_contained'` on the `timed_out`
  journal detail instead of silently implying it killed something.
- `core/job-store.js`: `kill_skipped` is projected into `status.json` (append-only field addition) and
  defaults to `null` — otherwise the honest record would be dropped by the whitelist projection.
- `core/cancel.js`: the all-rungs-failed fallback no longer records `cancelRungReached: 'hard_kill'`, which
  collided with the adapter's own `hard_kill` rung name. It now records `containment_unavailable` when there is
  no context, or `contained_tree_kill` when a context was actually asked to terminate; a kill reporting
  `terminated: false`/`survivors` yields `termination_unconfirmed` + exit 21 rather than a clean kill.
- `tests/core/hard-kill-honesty.test.js` (new) and an updated ambiguous assertion in
  `tests/core/cancel.test.js` test 3.

### Still open here, and moving to ticket 78

The acceptance criteria below that require an actual kill. Re-read them **after** 78 lands; at that point this
ticket reduces to "the hard timeout calls `context.terminate({graceMs})` and reports the outcome honestly".

## Acceptance criteria

- [ ] `core/commands/worker.js` hard-timeout handler (around line 200-215): after the rung walk fires, if the worker has a backend pid (or matched identity via `core/process-identity.js`), it calls `core/containment.js` `terminate(backendProcessIdentity)` — the same helper `core/cancel.js:80-86` uses — to kill the contained tree.
- [ ] The kill is innermost-first, re-snapshotting between steps (AGENTS §4 rules); capture any launcher layers (cmd.exe shims from codex/claude .cmd wrapping).
- [ ] The kill itself is bounded (~5s grace then force).
- [ ] After the kill: journal `timed_out` (today's behavior preserved), `tryDisposeAdapter`, release slot, `process.exit(24)`.
- [ ] If the worker has no backend identity recorded (spawn failed before the identity was persisted — ticket 72 territory), skip the kill but still journal `timed_out` and exit 24. Note this in the journal detail: `kill_skipped: 'no_identity'`.
- [ ] Test: a fake adapter configured to `hangForever` (ignore all cancel rungs) — the worker's hard-timeout eventually terminates the backend via containment, AND the backend's child (representative of a detached grandchild holding the stdout pipe) is also gone (verify via a pid-set check).
- [ ] Test: a fake adapter that responds to the polite cancel rung — kill is NOT called (preserve today's graceful escalation).
- [ ] Full suite green.

## Development guidance

- `core/cancel.js:80-86` already implements the contained tree-kill fallback (used by the CLI `cancel` command). Refactor that block into a shared `core/containment.js` `terminateTree(identity, { graceMs })` and have BOTH `cancel.js` and `worker.js` call it. Don't duplicate the kill logic.
- The worker already imports `core/containment.js` indirectly via `child-process.js` (`worker.js` uses `ManagedProcess` in tests, but production worker spawns the adapter in-process — adapter spawns the backend). The killed tree is the adapter's spawned backend tree.
- Persist the backend identity durably BEFORE waiting (`AGENTS.md` §5: "Launch identity must be persisted *before* it can be lost"). The worker reads `params.json` (which has the canonicalDir etc.) and persists `backend_pid`/`creation_time`/`image_path`/`execution_token` to status.json via journal transition. Verify the persisted identity is what the kill uses — not a pid that could have been reused by the time the kill fires.
- Coordinate with ticket 66 (Dispose timeout): when the hard-timeout calls `terminate` and then `tryDisposeAdapter`, the Dispose itself is bounded — so a wedged adapter can't extend the timeout harm.
- Do NOT skip the `tryDisposeAdapter` call even on hard-kill — Dispose still needs to clean up temp dirs and (for opencode) call `/global/dispose` (with a bounded HTTP, per ticket 59). A wedged server may already be dead; the bounded Dispose handles "already gone" gracefully (404 → swallow).

## Why it matters

When the rung walk fails (a real opencode server with a hang bug, a codex that ignores SIGINT), the worker records `timed_out` and exits — but the actual backend process (the one writing to the still-open stdout pipe the worker reads, or holding the temp dir) is still running. The next `submit` for the same backend sees the slot free (worker exited) and starts; resources the dead-tree holds (port, file, lock) collide. This is a real-leak, not theoretical.

## How to verify

```powershell
node tests/run-tests.js --suite full
# Live: configure a fake adapter with hangForever and a short DCLI_TEST_HARD_TIMEOUT_MS;
# inspect process tree before/after the worker's hard timeout — the spawned tree must be gone.
```

## Commit message

```
fix(worker): hard-timeout escalates to contained tree kill, not just polite cancel
```