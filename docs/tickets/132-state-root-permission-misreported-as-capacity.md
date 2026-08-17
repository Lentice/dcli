# 132 — state-root permission failures are reported as admission capacity

**Status:** done
**Blocked by:** —
**Tier:** Correctness and operability. A sandbox permission failure must tell the caller how to fix the runtime, not send it into a misleading capacity retry path.
**Filed from:** 2026-08-17 handoff reproduced in the normal Codex sandbox

---

## Symptom / Goal

When the dcli state root cannot be written, `run` reports `System at capacity
(global: 0/undefined)` as if admission were contended. The goal is to report a
classified, actionable state-root failure while preserving real contention and
limit results.

## Root cause

`LockManager.tryAcquire()` returned `null` for every error other than its stale
lock path. `AdmissionController.acquireSlot()` interpreted that `null` as
contention, and `job-setup.js` formatted the missing limit as `undefined`.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §7: "`15` | Permission / access-policy denial" and
"`17` | Lock acquisition or corrupt-state failure." A state-root permission
failure is `permission_or_sandbox`/15; only `EEXIST` is lock contention.

`AGENTS.md`: "Avoid an automatic fallback to another directory because it can
split resumable jobs and expose prompt/result data." The remedy must be an
explicit writable `DCLI_STATE_ROOT`, not a silent fallback.

## Files to read and trace first

- `core/state-root.js` — shared state-root probe and error identity.
- `core/locking.js` — exclusive lock creation and filesystem error boundary.
- `core/admission.js` — contention/limit/state-root result distinction.
- `core/job-setup.js` — pre-admission check and user-facing setup failure.
- `core/commands/worker.js` — detached admission path must not queue a storage failure.
- `cli/dcli.js` and `core/commands/doctor.js` — JSON error and diagnostic behavior.
- `tests/core/{state-root,locking,admission,setup-failure}.test.js` — regression seams.

## What to build

1. Treat only `EEXIST` as normal lock contention. Classify filesystem storage
   errors as `state_root_unwritable` with `permission_or_sandbox`/15 and the
   configured root path.
2. Preserve `contention`, `global_limit`, `backend_limit`, and
   `state_root_unwritable` as distinct admission outcomes. Give contention a
   real global limit so capacity text never formats `undefined`.
3. Probe writability before job setup/admission and report the remedy: grant
   runtime access or explicitly configure a private, sandbox-writable
   `DCLI_STATE_ROOT`.
4. Do not delete locks, raise limits, silently choose another root, or weaken
   state-root ACLs.

## Non-goals

- No new exit code or renamed persisted field; 15 already owns permission/access denial.
- No admission queue or retry-policy change; real contention keeps its existing bounded behavior.

## Acceptance criteria

- [ ] `run`/setup with an unwritable state root fails as `permission_or_sandbox`/15 and names `DCLI_STATE_ROOT`.
- [ ] A lock write `EPERM` cannot become admission `contention` or `0/undefined`.
- [ ] Real `EEXIST` contention and global/backend limits remain distinct and keep their existing behavior.
- [ ] Detached workers do not enqueue a `state_root_unwritable` job.
- [ ] `npm run check` is green and generated integration files are current.

## Agent checks

```bash
node tests/core/state-root.test.js
node tests/core/locking.test.js
node tests/core/admission.test.js
node tests/core/setup-failure.test.js
node scripts/generate-integration.js --check
npm run check
```

## Notes

Implemented 2026-08-17. The shared state-root probe now emits
`DCLI_STATE_ROOT_UNWRITABLE` with `permission_or_sandbox`/15; lock and
admission preserve the error instead of treating it as contention; setup,
doctor, and the detached worker report the actionable path/remedy. No fallback directory,
limit change, or lock deletion was added.

`npm run check` was run. Lint and all scoped tests passed; the full suite still
has unrelated baseline failures in `adapters/windows-tree-kill.test.js`,
`core/backend-error-vs-clean-exit.test.js`, and `core/cli-golden.test.js`
(`--version` fixture drift), plus a load-sensitive `.tmp-` assertion in the
parallel run. The failing files do not intersect this change; `job-store.test.js`
passes when run alone.
