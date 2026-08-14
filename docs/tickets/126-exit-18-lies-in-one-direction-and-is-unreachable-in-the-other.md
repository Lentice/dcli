# 126 — exit 18 claims the backend never ran when it did, and cannot be produced at all by the submit path

**Status:** done
**Blocked by:** —
**Tier:** Trust. Exit `18` is the one code that tells a delegating agent "no provider resources were
consumed — re-running this is free". It is wrong in both directions: the foreground path returns it after
the backend process has already started and been sent a prompt, and the detached `submit` path — the one
the shipped skills recommend for long work — cannot return it at all, because the worker's top-level
catch discards it and exits `1`. An agent that trusts `18` re-runs a job that already burned quota; an
agent that never receives it cannot tell a failed launch from a wrapper crash.

**Filed from:** a delegated Codex audit of exits `18` and `26` (2026-08-14), every claim re-verified
against the tree before filing. Ticket 121's non-goals explicitly deferred this audit: "Auditing whether
exits `18` and `26` are reachable ... deserves its own ticket if it turns out to be dead." `26` was
audited in the same pass and is **fine** — reachable, class-driven, and matching its documentation — so
this ticket is about `18` only.

**This is the third instance of one defect family.** Ticket 121: exit `10` documented everywhere,
unreachable, silently falling through to `1`. Ticket 122: exit `25` promising a repository state that was
not true. Both were found the same way and both were contract defects, not bugs in a feature. The pattern
is worth naming in whatever this ticket touches.

---

## Symptom / Goal

`docs/design-spec.md` §7 defines `18` as:

> | `18` | Worker launch / startup-sentinel failure |

and the version shipped to agents in `integration/source/core.md` is stronger — it promises the backend
never executed and consumed nothing.

### Defect A — the foreground path returns 18 after the backend has run

`core/commands/attempt-driver.js` puts three calls in one `try`:

```js
try {
  adapter.PrepareInvocation(attempt, request);
  await adapter.Start(attempt);
  if (hardTimedOut || cancelled) throw null;
  if (onStarted) onStarted(attempt);
  await adapter.SendPrompt(attempt, prompt);
  if (hardTimedOut || cancelled) throw null;
} catch (err) {
  ...
  return abandon(err);
}
```

and `abandon()` ends with:

```js
if (err && !err.exitCode) err.exitCode = 18;
throw err;
```

`SendPrompt()` runs **after** `await adapter.Start(attempt)` has succeeded. By then the backend child
process exists — the codex adapter has spawned it — so a `SendPrompt` failure exits `18` while the
backend is running or has run. The promise "nothing was consumed" is false.

The same `abandon()` also journals:

```js
failure_reason: 'adapter_start_failed',
failure: { class: 'worker_launch', message: ... },
```

so a prompt-send failure is recorded as a *start* failure. The exit code and the `failure_reason` field
tell the same untruth independently, which means fixing only one of them leaves the record misleading.

### Defect B — the detached path cannot produce 18 at all

`core/commands/worker.js` awaits `driveAttempt(...)` with no local try/catch, so `abandon()`'s throw —
carrying `err.exitCode = 18` — reaches the process-level handler:

```js
main().catch(err => {
  console.error('Worker fatal:', err.message);
  try {
    ... journalTransition(... failure_reason: 'worker_crash',
        failure: { class: 'worker_crash', message: err.message, source: 'wrapper' } ...)
  } catch {}
  writeSentinel(..., 1, 'failed');
  ...
  process.exit(1);
});
```

`err.exitCode` is never read. The sentinel records `1`, the process exits `1`, and the class is
overwritten with `worker_crash` on top of the `worker_launch` the driver just journaled.

Neither `worker_launch` nor `worker_crash` exists in the mapping:

```js
const FAILURE_CLASS_TO_EXIT_CODE = Object.freeze({
  backend_execution_failed: 10, no_result: 11, environment: 12, authentication: 13,
  quota_or_rate_limit: 14, permission_or_sandbox: 15, network_error: 16, lock: 17,
  protocol: 26, repository_state_unverified: 27,
});
```

so `18` is reachable **only** by the direct `err.exitCode` assignment, and only in the foreground. The
reducer's reverse lookup cannot recover it either:

```js
const failureClass = exitCodeToFailureClass(sentinelExitCode);
```

`exitCodeToFailureClass(1)` is `null`.

Goal: `18` means what it says on every path that can produce a launch failure, and a launch failure that
happens under `submit` is distinguishable from a wrapper crash.

## Root cause

`18` was wired as a direct numeric assignment on an error object rather than through the named-class
mapping every other terminal code uses. A code that bypasses the mapping is invisible to
`exitCodeToFailureClass`, cannot survive the sentinel round-trip, and has no single place where its
meaning is enforced — so a second exit path (the worker's own catch) was written without knowing it
existed.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §7, on both tables:

> Append-only contract: adding a class or a code is allowed, changing an existing value is not.

So `18` keeps its number and its meaning. `worker_launch` may be **added** to the mapping; nothing already
in it moves.

`core/failure-class.js`'s own header, which this ticket must not violate:

> This module must never *classify* (design-spec §8 — a bare number is not a discriminator); it only maps
> an already-named class to its contract code and back.

The class must therefore be named where the condition is known — the driver and the worker — and only
mapped here.

Invariant 2 still holds: adapters emit facts, the engine decides state. `Start()` and `SendPrompt()`
failures arrive as thrown errors from the adapter; the *classification* of which one happened belongs to
the driver, not the adapter.

Ticket 121 established the precedent for exactly this shape and its Notes record the decision:

> Added the `backend_execution_failed` class at exit `10` and assign it in the reducer for unclassified
> backend failures.

Follow that precedent where it applies, but note the difference: `18` is a **wrapper-side** condition
known before any backend fact exists, so the reducer is not necessarily the right owner. Decide and say
why.

## Files to read and trace first

- `core/commands/attempt-driver.js` — `abandon()`, the `err.exitCode = 18` assignment, and the
  `PrepareInvocation` / `Start` / `SendPrompt` try block. Both defects start here.
- `core/commands/worker.js` — the `await driveAttempt(...)` call with no local catch, `finish(code, state)`
  (which *does* carry the code into the sentinel on the normal path), `writeSentinel()`, and the
  `main().catch` handler. Note that the normal path already propagates an exit code correctly; only the
  throw path loses it.
- `core/worker-spawn.js` — `journalWorkerSpawnFailure()` sets `error.exitCode = 18` for a `submit` whose
  detached worker could not be spawned at all. **This one is correct** — the backend genuinely never ran.
  It is the reference for what `18` should mean, and it must keep working unchanged.
- `core/failure-class.js` — `FAILURE_CLASS_TO_EXIT_CODE`, `terminalExitCode`, `exitCodeToFailureClass`.
- `core/reducer.js` — the sentinel branch and its `exitCodeToFailureClass(sentinelExitCode)` reverse
  lookup; establish what the projected record looks like today for a detached launch failure.
- `core/commands/wait.js` — what a `submit` caller actually receives. If `wait` returns `0` for any
  terminal job, then the exit code is not the submit caller's signal at all and the fix has to make
  `status.json` carry the truth. Determine this before designing the fix; it changes what criterion D can
  even assert.
- `cli/dcli.js` — the outer catch that turns `err.exitCode` into the process status.
- `adapters/codex/adapter.js` — `Start()` and `SendPrompt()`, to confirm the child process exists before
  `SendPrompt` can throw. Do not take this ticket's word for it.
- `tests/contract/` and any test asserting `18` — a test asserting `18` for a `SendPrompt` failure is
  asserting defect A.

Line numbers drift; the function names above are the spec.

## What to build

### 1. Separate "never started" from "started, then failed"

`SendPrompt` leaves the `18` catch. A failure after `Start()` succeeded is not a launch failure, and must
not claim the backend consumed nothing. Where it goes instead is a decision this ticket must make and
record: `backend_execution_failed` (exit `10`, added by ticket 121) is the obvious candidate and needs no
new code, but confirm its documented meaning fits a prompt that was never delivered.

`PrepareInvocation` and `Start` keep `18`.

Fix the journal in the same change: a post-`Start` failure must not record
`failure_reason: 'adapter_start_failed'`.

### 2. Give the launch failure a named class

Add `worker_launch` to `FAILURE_CLASS_TO_EXIT_CODE` at `18` — an append, permitted by the contract. The
driver already journals that class name, so this makes the existing record consistent with the mapping
instead of inventing a name.

### 3. The detached path must not discard the code

`worker.js`'s `main().catch` writes the sentinel with `err.exitCode` when the error carries one, falling
back to `1` only for a genuinely unclassified crash. Decide what happens to the `worker_crash` class it
journals on top of the driver's `worker_launch` — two terminal journal entries for one failure is its own
problem, and the implementer must determine which one the reducer's projection actually ends up using
rather than assuming.

### 4. Documentation in the same commit

- `docs/design-spec.md` §7: `18`'s row states what it does **not** cover (a failure after the backend
  started), since that is the misreading this ticket exists to close. §8: the `worker_launch` class row.
- `integration/source/core.md`: the agent-facing `18` row currently promises no provider resources were
  consumed. That promise becomes true once step 1 lands — verify the wording still matches, and add
  whatever row the step-1 decision requires.
- Regenerate with `node scripts/generate-integration.js`, re-run `install.ps1`, confirm the installed
  `SKILL.md` copies byte-match the repo.

## Non-goals

- **Exit `26`.** Audited in the same pass and found correct: reachable via the `protocol` class from a
  backend's own structured error, mapped at `failure-class.js`, matching its documentation. Re-auditing it
  here wastes the budget.
- **opencode's silent skipping of malformed SSE event JSON** (`adapters/opencode/transport.js`). The audit
  raised it; it is a deliberate, documented decision (opencode-study §6, and the method's own JSDoc says
  "malformed JSON data is skipped, never fatal"). If it deserves revisiting, that is a spec question and
  its own ticket. Note that the same method's outer `catch (err) { return; }` silently ends the stream on
  any mid-stream error — also out of scope here, and worth its own look.
- **`review`'s malformed findings appendix not changing the exit code.** The audit called this a defect by
  reading `design-spec.md` §11's "Classify the job as `protocol` only when strict structured output was
  explicitly required" as a mandate. It is a restriction, there is no strict mode in `core/commands/review.js`,
  and `findings_status` is already machine-readable in the envelope. Not a defect; do not "fix" it.
- **Redesigning how the worker reports terminal state.** The sentinel mechanism stays; this ticket makes
  it carry the code it already has.
- **Auditing the remaining exit codes.** `18` and `26` were the two ticket 121 deferred. If this work
  suggests another is dead, file it.

## Acceptance criteria

- [ ] **A.** A `SendPrompt` failure after a successful `Start()` does **not** exit `18`, proven by a test
  that drives the fake adapter to fail at `SendPrompt`. Notes state which code it exits and why.
- [ ] **B.** A `PrepareInvocation` or `Start` failure still exits `18`, proven by the existing test if one
  covers it, or by a new one.
- [ ] **C.** `exitCodeToFailureClass(18)` returns `worker_launch`, and `failureClassToExitCode('worker_launch')`
  returns `18`.
- [ ] **D.** A detached (`submit`) job whose adapter fails to start records `18` in its sentinel and a
  `worker_launch` class in `status.json` — not `1` and not `worker_crash`. If `wait` returns `0` for all
  terminal jobs, say so in Notes and assert the record instead of the process status; do not silently
  weaken the criterion.
- [ ] **E.** `core/worker-spawn.js`'s existing `exitCode = 18` for a failed detached spawn is unchanged and
  still produces `18`.
- [ ] **F.** No journal entry records `adapter_start_failed` for a failure that happened after `Start()`
  returned.
- [ ] **G.** No backend-specific conditional entered `core/` (invariant 1), and no adapter assigns a
  failure class (invariant 2).
- [ ] **Z.** `npm run check` green; tracker table regenerated via `node scripts/generate-tickets-table.js`;
  `docs/design-spec.md`, `docs/reference/*` and `integration/source/*` updated in the same commit, with
  installed skill copies verified byte-identical.

## Agent checks

```bash
# 18 now round-trips through a named class like every other terminal code:
node -e "const f=require('./core/failure-class');console.log(f.exitCodeToFailureClass(18), f.failureClassToExitCode('worker_launch'))"
# expect: worker_launch 18

# SendPrompt is no longer inside the launch-failure catch:
grep -n "SendPrompt" core/commands/attempt-driver.js
# expect: not in the same try block as PrepareInvocation/Start

# The worker no longer throws away a carried exit code:
grep -n "exitCode" core/commands/worker.js
# expect: main().catch reads err.exitCode before falling back to 1

# The correct 18 site is untouched:
grep -n "exitCode = 18" core/worker-spawn.js
# expect: still present

# No backend name leaked into the engine (invariant 1):
grep -rniE "codex|opencode|claude" core/failure-class.js core/commands/attempt-driver.js
# expect: no output

# Docs and installed skills agree:
node scripts/generate-integration.js --check
# expect: passes with no drift reported
```

## Notes

Implemented the launch/started split:

- `PrepareInvocation` and `Start` failures remain `failure_reason: adapter_start_failed`, now with the
  named `worker_launch` class and exit `18` in both directions through `core/failure-class.js`.
- A `SendPrompt` failure after `Start()` succeeds is recorded as
  `failure_reason: backend_execution_failed`, class `backend_execution_failed`, and exit `10`; it no
  longer claims the backend failed to start.
- The detached worker preserves a carried exit code and skips the duplicate `worker_crash` journal
  entry, so a detached launch failure writes sentinel exit `18` and projects `worker_launch`.
- Added foreground, detached-worker, and mapping regressions. Existing `core/worker-spawn.js` exit `18`
  behavior remains unchanged.
- Updated `docs/design-spec.md`, all three CLI references, `integration/source/core.md`, generated
  skills, and reinstalled/verified the Claude and agents skill copies byte-for-byte.

Direct checks passed:

- `node tests/core/failure-class.test.js`
- `node tests/core/attempt-population.test.js`
- `node tests/core/worker-startup-failure.test.js`
- `node tests/core/test-runner.test.js`
- `node tests/core/attempt-driver.test.js`
- `node tests/core/worker-spawn.test.js`
- targeted `npx eslint` and `git diff --check`

Per the user's instruction, `npm run check` was not run. The implementation and direct ticket checks are
complete; the full-suite gate is intentionally unverified.
