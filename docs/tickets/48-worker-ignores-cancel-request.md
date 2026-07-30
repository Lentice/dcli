# 48 — Worker ignores `cancel.request`; cancellation races the projection

**What to build:** cancellation of a submitted job is driven by the *worker* observing `cancel.request`
and tearing itself down (journaling `cancelled` through the reducer), rather than relying solely on the
`cancel` command killing the worker from outside and then racing the worker's own terminal journal entry.

**Blocked by:** 47 (the reducer projection fix is what makes a self-reported `cancelled` stick; without it
either the worker's or the command's terminal entry can be overwritten)

**Status:** ready-for-agent

- [ ] `core/commands/worker.js` observes `cancel.request` in the job directory on a bounded cadence while
      running, and on detection stops the backend via the adapter-declared cancel rungs (with the **real**
      attempt), then journals `cancelled` and exits — it does not continue to `process_exited → done`.
- [ ] When the worker self-cancels and the `cancel` command's external kill is also in flight, the two do
      not produce conflicting terminal entries that flip the visible state (covered by 47's projection
      contract).
- [ ] `cancel` returns exit 21 ("termination unconfirmed") only when both the external kill *and* the
      worker self-shutdown failed; if the worker self-shuts down, cancel observes that and succeeds.
- [ ] Regression test: write `cancel.request` while a fake adapter's `Observe` is mid-flight; assert the
      worker stops within a bounded window, journals `cancelled`, and no live worker/backend process
      remains. Verify the subsequent `process_exited` (if any late fact arrives) does not resurrect `done`.
- [ ] Full suite green.

## Notes

Today `core/cancel.js` writes `cancel.request` and journals `cancel_requested_at`, then walks rungs and
hard-kills from the command process. `core/commands/worker.js` has **no `cancel.request` watcher** and
never voluntarily stops — the only thing that ends the job is the external kill. If that kill is
unconfirmed (exit 21) the worker keeps running and, per ticket 47, can later overwrite the cancelled
record with `done`/`failed`.

The architectural intent (AGENTS pitfall #5) is that a worker that should already be dead must not be
able to overwrite a terminal decision. Self-observation of `cancel.request` makes the worker cooperative
rather than adversarial to the projection.