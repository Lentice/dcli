# 69 — Worker hard-timeout never kills the backend process tree; the tree survives after `timed_out`

**What to build:** the worker's hard-timeout timer — when `cancelThroughRungs` walk fails or the adapter ignores the cancel signal — escalates to `containment.terminate(...)` to provably kill the backend process tree, not just ask politely. Today `worker.js`'s hard-timeout calls `requestCancelRungs()` (rung walk) then journals `timed_out` and `process.exit(24)` — the backend process tree (the one with the real孙子 processes holding stdin/stdout pipes) keeps running outside any Job Object, holding resources and locks until the OS reaps it. This is exactly the incident that started the predecessor's "`AGENTS.md` §1: unbounded wait cost a user eight hours."

**Blocked by:** Ticket 55 (both touch the worker terminal/journal paths — sequence 55 first so the reducer drives state, then 69's kill-on-hard-timeout uses that state)

**Status:** ready-for-agent

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