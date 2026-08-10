# 101 — The reducer decides whether a state may be published; today `JobStore` re-derives it by string match

**Status:** done
**Blocked by:** —
**Tier:** Correctness. Invariant 2 says the engine decides state. Half that decision — "may this
inferred state be written?" — lives in the store and identifies the reducer's outcome by matching a
`failure.reason` string. Add a branch to the reducer and the guard silently stops covering it.
**Filed from:** architecture review, 2026-08-10 (verified against the tree at `adcbac1`).

---

## Symptom / Goal

`core/reducer.js` is the deepest module in the repository: a simple interface (`state, facts,
evidence -> outcome`) over substantial rules. But whether a reduced state may be *persisted* is decided
in `JobStore.reconcileStatus`, and that decision re-encodes reducer knowledge as a string comparison:

```js
const expiredIdentityless = freshEvidence.workerIdentityMissing === true &&
  freshReduced.state === 'interrupted' &&
  freshReduced.failure && freshReduced.failure.reason === 'worker_identity_missing';
if (freshEvidence.workerAlive !== false && !freshEvidence.completionSentinelPresent &&
    !expiredIdentityless) return fresh;
```

`'worker_identity_missing'` is produced by the reducer. If a future reducer branch produces a different
reason for the same situation, this guard stops matching and the record never terminates — which is the
exact defect ticket 85 was filed for. If a new branch produces a *publishable* outcome, the guard
silently refuses to publish it.

The whole preview-then-re-derive-under-lock dance exists because the store has to guess which of the
reducer's outcomes are safe to persist.

Goal: the reducer returns the answer it already knows.

## Root cause

`reduce()` returns what the state *is*, but not whether the evidence is strong enough to write it. That
second judgement is inseparable from the first — it depends on the same evidence and the same branch —
so it was reconstructed at the only place that needed it.

## Binding constraints — quoted, do not go looking for them

Invariant 2, from `AGENTS.md`: "Adapters emit facts; the engine decides state." This ticket strengthens
it — the *whole* decision, including publishability, moves into the engine's reducer.

Invariant 4 is append-only: `reduce()` gains a field. **No existing return field changes name or
meaning**, and no `status.json` field changes.

The comment already in `core/job-store.js` states the rule the new field must encode, and it is the
specification — quote it into the reducer:

> Publish only on POSITIVE evidence that the owner is gone. A stale heartbeat with unknown liveness is
> enough to *display* `interrupted`, but not to write it. The sole exception is the explicit
> legacy-record rule in the reducer: its own hard deadline has elapsed, so no worker can still be inside
> the recorded budget.

And the reason the lock-free preview is re-derived under the lock, which must survive unchanged:

> the decision that gets WRITTEN must be re-derived under the lock, because a heartbeat or a terminal
> transition can land between the preview and the acquisition — and an inference from evidence that is
> already superseded is exactly the kind of stale terminal this whole path exists to avoid.

Tickets 84 and 85 (both done 2026-08-04) established the identityless-record rule. Read their Notes;
this ticket must preserve their behaviour exactly, not re-decide it.

## Files to read and trace first

- `core/reducer.js` — `reduce()`, every branch that returns a terminal state, and the sentinel handling
  that produces `worker_identity_missing`.
- `core/job-store.js` — `reconcileStatus()` in full: the cheap lock-free exit, `gatherEvidence`, the
  preview, the lock acquisition, the re-derive, `expiredIdentityless`, and `_publishReconciled`.
- `core/job-store.js` — `gatherEvidence()`: `workerAlive`, `workerIdentityMissing`,
  `completionSentinelPresent`. These are the inputs the new field is computed from.
- `tests/core/job-store.test.js`, `tests/core/worker-liveness.test.js`, and ticket 85's regression test —
  the behaviour that must not move.

## What to build

### 1. `reduce()` returns `publishable`

```js
reduce(status, facts, evidence) -> { state, phase, failure, backend_session_id, /* … */, publishable }
```

`publishable` is `true` only on positive evidence that the owner is gone:

- the completion sentinel is present, **or**
- `workerAlive === false`, **or**
- the identityless-and-past-its-own-deadline rule the reducer already implements.

The rule is expressed against the same branch that produced the state, not against the reason string.

### 2. `reconcileStatus` stops re-deriving

```
regenerate → gather evidence → reduce → if (!reduced.publishable) return projected
          → take lock → regenerate → gather → reduce → if (!reduced.publishable) return fresh
          → publish
```

The `expiredIdentityless` string match is deleted. The lock-free-preview-then-re-derive-under-lock
structure stays exactly as it is — it is load-bearing, per the quoted comment.

### 3. A pure test for publishability

Every evidence combination asserted directly against `reduce()`: worker alive; worker dead; liveness
unknown with a stale heartbeat; sentinel present; identityless within deadline; identityless past
deadline. Today these are reachable only through `reconcileStatus` with a live filesystem.

## Non-goals

- **Changing when a job terminates.** Behaviour is identical; only where the decision is made moves.
- **Removing the double reduce under the lock.** It exists because evidence can change between preview
  and acquisition.
- **Reworking `gatherEvidence`.** Its outputs are the reducer's inputs and they stay as they are.
- **Adding a `status.json` field.** `publishable` is a reducer return value, not persisted state.

## Acceptance criteria

- [ ] **A.** `reduce()` returns `publishable`, and its rule is documented in `core/reducer.js` with the
  "positive evidence" paragraph quoted above.
- [ ] **B.** `core/job-store.js` contains no comparison against a `failure.reason` string literal.
- [ ] **C.** `reconcileStatus` decides solely from `reduced.publishable`, plus the terminal and
  worker-alive early exits it already has.
- [ ] **D.** A pure unit test covers all six evidence combinations against `reduce()` with no filesystem.
- [ ] **E.** Ticket 85's regression test passes unchanged: an identityless record past its own deadline
  still terminates, and one within its deadline still does not.
- [ ] **F.** A job whose worker is alive is still never given an inferred terminal state by a passing
  `status`, `wait` or `list`.
- [ ] **Z.** `npm run check` green.

## Agent checks

```bash
# No reducer knowledge re-encoded in the store.
grep -n "worker_identity_missing\|failure.reason ===" core/job-store.js
# expect: nothing

# The reducer owns it.
grep -n "publishable" core/reducer.js core/job-store.js
# expect: defined in reducer.js, consumed in job-store.js

# No new persisted field.
grep -n "publishable" core/job-store.js | grep -i "status\|journal"
# expect: nothing written to status.json or the journal

npm run check
# expect: green
```

## Handoff

**Extra reading, beyond `AGENTS.md` and `00-onboarding.md`** — `docs/design-spec.md` §5 (`status.json`
contract) and §15 (locking), plus the Notes of **tickets 84 and 85**
(`84-launch-identity-never-persisted.md`, `85-identityless-records-never-terminate.md`). Those two
established the identityless rule this ticket relocates without changing. Nothing else.

**Implementation order:**

1. Write the pure publishability suite (criterion D) against a `reduce()` that does not yet return
   `publishable`. Six cases: worker alive; worker dead; liveness unknown with a stale heartbeat;
   sentinel present; identityless within deadline; identityless past deadline. Verify red.
2. Add `publishable` to `reduce()`, computed **in the same branch that produces the state** — not by
   inspecting the reason string afterwards, which would just move the defect.
3. Replace `expiredIdentityless` in `reconcileStatus` with `reduced.publishable`. Delete the string
   comparison.
4. Run tickets 84's and 85's regression tests. They must pass unchanged (criterion E).

**Running tests while you work:**

```bash
node tests/core/reducer.test.js
node tests/core/job-store.test.js
node tests/core/worker-liveness.test.js
npm run check
```

**Traps specific to this ticket:**

- **Keep the double reduce.** The lock-free preview and the re-derive under the lock look redundant and
  are not: evidence can change between the two, and publishing from superseded evidence is the stale
  terminal this whole path exists to prevent. The comment quoted above is the specification.
- `publishable` is a **return value, not a persisted field**. It must not appear in `status.json` or the
  journal (criterion C's grep checks this). Adding it to `status.json` would be a new contract field.
- A terminal state is monotonic. A `cancelled` inferred by a passing `status`, `wait` or `list` — none of
  which are cancelling anything — permanently outranks the `done` the worker was about to write. That is
  why `workerAlive === true` short-circuits before any of this; keep that early exit first.
- If you find a reducer branch whose publishability is genuinely ambiguous, **stop and ask** rather than
  guessing — you would be deciding when a job is allowed to terminate.

**Commit message:**

```
ticket 101: the reducer decides whether a state may be published
```

## Notes

### How the publishability rule maps to reducer branches

`reduce()` now returns `publishable` on every path. The rule is one predicate,
`workerGone || hasSentinel`, with the identityless branch as the sole
exception:

- **Already terminal** — `publishable: true`. Nothing is inferred; the state is
  already durable, so there is nothing to gate. Never consulted by
  `reconcileStatus` (it returns early on terminal projections).
- **Identityless-past-own-deadline** (the ticket-85 rule, unchanged) —
  `publishable: true`. This branch is the quoted exception: its own recorded
  hard deadline has elapsed, so no worker can still be inside the budget.
- **Cancel requested / hard timeout / process_exited / backend_error /
  stream_closed** — `publishable: workerGone || hasSentinel`. The cancel and
  hard-timeout branches are reachable with unknown liveness (stale heartbeat,
  no sentinel): they *display* `cancelled`/`timed_out` but are not written —
  exactly what the old store guard `workerAlive !== false &&
  !completionSentinelPresent` enforced.
- **Reconciliation branches** (worker gone ± sentinel ± heartbeat) — all are
  gated on `effectiveWorkerGone` (workerAlive `false`), so they are
  `publishable: true`, **except** the `heartbeat_stale` branch, which may also
  fire with `workerAlive === null` — unknown liveness is display-only.
- **Token-mismatch edge** — `effectiveWorkerGone` can be true while
  `workerAlive === true` (a reused pid the evidence layer flagged). There the
  predicate stays `false`, which preserves the old behaviour exactly: the store
  short-circuits on `workerAlive === true` before reduce is even called, so
  such an `interrupted` was never published before either.
- **`noChange` / non-terminal** — `publishable: false`.

The predicate is computed from the same evidence booleans (`workerGone`,
`hasSentinel`) that the branches themselves check — never from the
`failure.reason` string. The quoted "positive evidence" paragraph is
documented in `core/reducer.js` at the definition site.

### `reconcileStatus` shape after the change

```
regenerate → TERMINAL? return → gather → workerAlive === true? return
  → reduce → state unchanged or !publishable? return
  → lock (non-blocking) → regenerate → TERMINAL? return → gather
  → workerAlive === true? return → reduce → state unchanged or !publishable? return
  → _publishReconciled
```

`expiredIdentityless` and the `'worker_identity_missing'` string match are
deleted. The lock-free-preview-then-re-derive-under-lock structure and the
quoted load-bearing comment are untouched.

### Pure test suite — `tests/core/reducer-publishability.test.js`

No filesystem; each combination asserted directly against `reduce()`:

1. worker alive → `running`, `publishable: false`
2. worker dead (no sentinel, stale heartbeat) → `interrupted`, `publishable: true`
3. liveness unknown + stale heartbeat → `interrupted`, `publishable: false`
4. completion sentinel present → `done`, `publishable: true`
5. identityless within its own deadline → `running`, `publishable: false`
6. identityless past its own deadline → `interrupted` +
   `worker_identity_missing`, `publishable: true`
7. every `reduce()` result carries a boolean `publishable` (all six combos plus
   the already-terminal path)

### Discovery — pre-existing failure unrelated to this ticket

`tests/core/worker-liveness.test.js` section 6g fails on the clean tree at
HEAD (`0ee176c`), before any of this ticket's changes: "a corrupt projection
must be regenerated, not reported as an unreadable job". `listJobRecords`
regenerates only when the projection is *stale* (`journal.mtime >=
status.mtime`); the test writes `status.json` corrupt *after* the journal, so
the projection is newer, `JSON.parse` fails, and the job lands in `errors`
instead of `records`. `tests/core/job-store-scan.test.js` (the corruption
judgement table, same scenario) passes, so this is an mtime/timing edge of
ticket 96's implementation on this machine, not a 101 regression. The
identityless regressions (6m/6n/6o) and all other worker-liveness sections
pass; they were run by splicing the failing 6g section out of a scratch copy,
which was deleted before committing. Flagged for ticket 96 or 105.

### Verification

- Acceptance A–F and the three Agent-check greps all pass.
- `npm run check` was **not** run in full (per operating instruction); the
  relevant suites — `reducer`, `reducer-backstop`, `reducer-publishability`
  (new), `job-store`, `job-store-scan`, `cleanup-worktrees`,
  `submit-launch-identity` (ticket 84 regression), `worker-liveness` (all but
  the pre-existing 6g) — plus `npm run lint` are green.
- Behaviour is unchanged: 6i (never publish for a live worker), 6k (a dead
  worker is not reported as `cancelled`), 6m/6n/6o (identityless rule), and
  ticket 84's launch-identity regression all pass unchanged.
- `publishable` is a reducer return value only; greps confirm nothing writes it
  to `status.json` or the journal.
