# 47 — Reducer and reconciliation are bypassed on the submit path

**What to build:** `status.json` for a *submitted* job is the output of the engine-owned reducer applied
to (current state + facts + durable evidence), so that a crashed worker whose process is gone but left no
`process_exited` fact is reconciled to `interrupted` (never stuck `running`), and so that a cancel flag or
hard-timeout deadline cannot be overwritten by a later journal entry from a worker that should already be
dead.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] The lifecycle reducer (`core/reducer.js`) is applied on the submit/background path, not only from the
      synchronous `run` command where it is currently the sole caller.
- [ ] `status.json` projection reflects reducer outcomes: a worker whose process has died with no
      completion sentinel and a stale/absent heartbeat resolves to `interrupted`, not `running` forever.
      The job never remains permanently `running` once its worker is dead and reconciliation has run.
- [ ] A stale-but-alive worker holding a finished result surfaces the `process_outlived_completion` warning
      from the reducer on the submit path (today the reducer rule is unreachable for submitted jobs).
- [ ] Reconciliation is invoked from a defined, bounded trigger (e.g. `status`/`wait`/`debug` read paths
      and/or a periodic worker heartbeat check), with every wait bounded per invariant #3.
- [ ] Cancel and hard-timeout terminal decisions made by the reducer cannot be silently overwritten by a
      later raw journal `to: 'done'/'failed'` replayed by `_applyJournalEntry`.
- [ ] Regression tests for each: (a) worker dies leaving journal in `running` with no `process_exited` →
      after reconciliation the job is `interrupted`; (b) `cancel_requested_at` is set and the worker later
      appends `process_exited → done` → the visible state is `cancelled`, not `done`.
- [ ] Full suite green; no backend-specific conditional is added to `core/` (invariant #1).

## Notes

`core/reducer.js` is currently invoked from exactly one place — `core/commands/run.js` (grep confirms
`reduce(...)` only at `run.js:205`). The worker (`core/commands/worker.js`) journals terminal state
directly from a `process_exited` fact and never runs the reducer, and `core/job-store.js`
`_applyJournalEntry` rebuilds `status.json` by replaying journal `to` values without applying the reducer.

This means the entire reducer — including its `cancel_requested_at → cancelled` rule (#2) and the
`interrupted`/`heartbeat_stale` reconciliation logic — is **dead code on the submit path**. Two failure
modes that the architecture claims are designed against are live here:

1. A crashed/stranded worker leaves the journal in `running` with no terminal fact → the job is
   permanently `running`. No `status`/`wait`/`debug` path re-runs reconciliation. (AGENTS pitfall #5 /
   #2 — "a job permanently stuck in `created`/`running`" and "stale-job reconciliation".)
2. A live worker that should already be cancelled appends `process_exited → done` after `cancel` wrote
   `cancel_requested_at`; `_applyJournalEntry` sets `state = 'done'`, overwriting the cancellation — the
   exact "live worker overwrote the cancelled record" bug.

Decision point for the implementer: either project `status.json` by running facts+evidence through the
reducer at each read/append, or enforce these rules inside the journal replay so the projection and the
reducer agree. The contract is that the engine decides state from facts (invariant #2); both paths must
honour it.