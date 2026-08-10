# 95 — One job-creation preamble: `run`, `resume` and `submit` stop writing it three times

**Status:** done
**Blocked by:** —
**Tier:** Correctness. The ownership boundary that releases a worktree and an admission slot on setup
failure exists in three near-copies. Ticket 90 had to fix that leak once; the next fix will have to be
made in three places, and the duplicated explanatory comment is the proof that it already was.
**Filed from:** architecture review, 2026-08-10 (verified against the tree at `adcbac1`).

---

## Symptom / Goal

`core/commands/run.js` and `core/commands/resume.js` contain the same sixty-line sequence:

```
prepareBackend → admission.acquireSlot → store.createJob → store.createAttemptDir
              → persistInitFiles → journal `attempt_created` → journal created→running
```

They differ only in `sessionStrategy`, the access fallback, and a worktree seed commit.
`core/commands/submit.js` is a third variant of the same sequence, with admission deferred to the
worker and an extra `params.json` write.

The tell is that the explanatory comment is duplicated verbatim. `run.js`:

> Setup ownership boundary: every resource acquired below (the worktree and the admission slot) is
> either handed to runAttempt() below, or released by this guard before rethrowing. A failure in
> createJob/createAttemptDir/persistInitFiles used to exit without either, stranding the worktree and
> burning the durable slot until reconciliation.

`resume.js`:

> Setup ownership boundary: same contract as run.js — the worktree and the admission slot acquired
> below are either handed to runAttempt() or released here before rethrowing. A failure in
> createJob/createAttemptDir/persistInitFiles used to strand both.

A comment that says "same contract as run.js" is a module boundary that was never cut.

Goal: one module owns bringing a job into existence, including the release-everything guard.

## Root cause

No module is named for job creation, so each command grew its own. The guard is the part that hurts:
it is a correctness invariant (acquire-or-release-all) implemented three times, and ticket 90 had to
touch two of the three to fix one bug.

## Binding constraints — quoted, do not go looking for them

From `docs/design-spec.md` §6 (Lifecycle): the journal is the source of truth and `status.json` is a
projection of it. The `attempt_created` entry and the `created` → `running` transition are journal
kinds; invariant 4 makes them append-only. **This ticket emits exactly the entries emitted today, with
the same detail keys.**

From `docs/design-spec.md` §15 (Locking and concurrency): the admission slot is durable state. A slot
acquired and not released is burned until reconciliation, which is why the guard exists.

Ticket 90 ("setup failure releases resources", done 2026-08-09) is the bug this consolidation prevents
recurring. Read its Notes before starting; do not undo its fix.

## Files to read and trace first

- `core/commands/run.js` — the canonical preamble and its guard.
- `core/commands/resume.js` — the second copy, plus lineage fields (`parentJobId`, `sessionStrategy`)
  and the worktree seed commit.
- `core/commands/submit.js` — the third variant: admission deferred to the worker, `params.json`
  written, `executionToken` minted.
- `core/job-store.js` — `createJob`, `createAttemptDir`, `journalTransition`; what each requires.
- `core/admission.js` — `acquireSlot` / `releaseSlot` semantics, and what "durable slot" means.
- `core/worktree.js` — worktree creation and the seed commit, and what must be released on failure.
- `core/commands/attempt.js` (or `attempt-driver.js` if ticket 92 has landed) — the consumer of the
  handle this module returns.
- `tests/core/setup-failure-*.test.js` or whatever ticket 90 added — these pin the guard's behaviour.

## What to build

### 1. `core/job-setup.js`

```js
openAttempt({
  store, adapter, request, repoKey, repoRoot,
  mode, access, group, label, model, hardTimeoutSec, stateRoot,
  lineage,            // { parentJobId, sessionStrategy } | null
  admission,          // null when the caller defers acquisition (submit)
  durableIdentity,    // executionToken and friends, when the caller mints them
}) -> { jobId, attemptNum, backend, backendVersion, adapterVersion, worktree, acquiredSlotId, release() }
```

It owns the ownership boundary. `releaseSetupResources` becomes internal to this module and is no
longer exported or duplicated.

`release()` on the returned handle is the caller's escape hatch for a failure *after* setup succeeded;
a failure *inside* `openAttempt` releases everything before rethrowing, exactly as today.

### 2. `run`, `resume`, `submit` become argument suppliers

Each keeps only what is genuinely its own: `run` the access fallback; `resume` the lineage fields and
the seed commit; `submit` the `params.json` write, the deferred admission (`admission: null`), and the
worker spawn.

### 3. One table-driven test suite for setup failure

Admission full, `createJob` throwing, `createAttemptDir` throwing, `persistInitFiles` throwing,
worktree already exists — each asserted once against `openAttempt`, not three times through three
commands.

## Non-goals

- **Merging the attempt *driver*.** That is ticket 92. Setup and drive are two seams; cutting both in
  one commit makes the diff unreviewable.
- **Making `submit` acquire the admission slot eagerly.** The deferral is deliberate — the worker owns
  the slot for a detached job. `openAttempt` takes `admission: null` to express that.
- **Unifying the worker spawn.** That is ticket 97.
- **Changing any journal kind or detail key.** Append-only.

## Acceptance criteria

- [x] **A.** `core/job-setup.js` exists and is the only place `store.createJob` is called from a command.
- [x] **B.** The "Setup ownership boundary" comment appears exactly once in the repository.
- [x] **C.** `run.js`, `resume.js` and `submit.js` each contain no `acquireSlot` / `releaseSlot` pair;
  release-on-failure lives in `job-setup.js`.
- [x] **D.** For each of the five setup-failure cases, no worktree directory and no held admission slot
  remain afterwards. Asserted directly against the state root.
- [x] **E.** The journal produced by `run`, `resume` and `submit` is byte-identical to the journal
  produced before this change, for one representative job each.
- [x] **Z.** `npm run check` green; docs updated only if a user-visible message changed (it should not).

## Agent checks

```bash
# The boundary comment exists once.
grep -rn "Setup ownership boundary" core/
# expect: exactly one line, in core/job-setup.js

# createJob has one command-side caller.
grep -rn "\.createJob(" core/ cli/
# expect: one line in core/job-setup.js, plus core/job-store.js's definition

# No backend name in the new module (invariant 1).
grep -niE "codex|opencode|claude" core/job-setup.js
# expect: nothing

npm run check
# expect: green
```

## Handoff

**Extra reading, beyond `AGENTS.md` and `00-onboarding.md`** — `docs/design-spec.md` §6 (lifecycle) and
§15 (locking and concurrency), plus **ticket 90's Notes** (`90-setup-failure-releases-resources.md`), the
bug this consolidation prevents recurring. Nothing else.

**Implementation order:**

1. **Capture the baseline journals first.** For one `run`, one `resume` and one `submit` against the fake
   adapter, snapshot `journal.jsonl` to fixtures. Criterion E is a byte comparison against these.
2. Write the table-driven setup-failure suite (criterion D) against a `core/job-setup.js` that does not
   exist yet. Verify red.
3. Create `core/job-setup.js` by **moving** `run.js`'s preamble verbatim, parameterised only by what
   `run` already varies. Point `run.js` at it. Suite green, journals byte-identical.
4. Point `resume.js` at it, adding `lineage` and the seed-commit hook. Suite green.
5. Point `submit.js` at it with `admission: null`, keeping its `params.json` write and worker spawn in
   `submit.js`. Suite green.
6. Delete the duplicated `releaseSetupResources` copies; make it internal to `job-setup.js`.

**Running tests while you work:**

```bash
node tests/core/submit-e2e.test.js
npm test
npm run check
```

**Traps specific to this ticket:**

- `submit` deliberately does **not** acquire the admission slot — the detached worker does. If you
  "helpfully" make `openAttempt` always acquire, every submitted job burns a slot twice. `admission:
  null` is the contract, not an oversight.
- The release guard must release **everything acquired so far**, in reverse order, and then rethrow the
  original error. Do not swallow it, and do not release things the caller now owns.
- `resume` seeds the worktree from the parent's artifacts. That step happens *inside* the ownership
  boundary — a failure after it must still remove the worktree.
- The journal entries and their detail keys are append-only. If your refactor changes a key's spelling
  the byte comparison in criterion E will catch it; do not "fix" the fixture.

**Commit message:**

```
ticket 95: one job-creation preamble for run, resume and submit
```

## Notes

(Left empty by the author.)

### Implementation — 2026-08-10, opencode

`core/job-setup.js` owns the whole preamble: implement-mode worktree creation (including resume's seed
commit), `prepareBackend`, admission acquisition, `createJob`, `createAttemptDir`, `persistInitFiles`,
and — for foreground runs — the `attempt_created` + `created→running` journal entries, all inside one
release guard. `run.js` / `resume.js` / `submit.js` are argument suppliers (~20 lines each); the shared
`releaseSetupResources` was deleted from `core/commands/attempt.js`.

**openAttempt interface** (as shipped, extending the sketch):

```
openAttempt({ store, adapter, request, prompt, repoKey, repoRoot, mode, access, group, label, model,
             hardTimeoutSec, stateRoot, lineage, seedCommit, admission, commandMode, hardTimeoutMs,
             durableIdentity, journalLaunch })
-> { jobId, attemptNum, backend, backendVersion, adapterVersion, worktree, worktreeBaseCommit,
     acquiredSlotId, release() }
```

- `prompt` is needed by `persistInitFiles`; `worktreeBaseCommit` is needed by the `driveAttempt` handoff
  (the sketch's handle omitted both).
- `mode` is already effective (`implement` | `run` | `submit`); `request.canonicalDir` is upgraded to
  the worktree path when a worktree is created.
- `lineage: { parentJobId, sessionStrategy, rootJobId }` — `rootJobId` added because both resume and
  submit compute `parentStatus.root_job_id || parentJobId` and `createJob` needs it.
- `seedCommit` — resume's `fork_from_artifacts` base ref, passed through to `createDetachedWorktree`
  inside the ownership boundary.
- `release()` on the handle is the caller's escape hatch for a failure after setup; run/resume hand the
  resources straight to `driveAttempt` and never call it (driveAttempt owns them), submit holds none.
- The guard releases worktree then slot (ticket 90's order), rethrows the original error, and never
  removes a worktree path it did not create.

**Baseline journals (criterion E).** Captured from the pre-change tree with
`node tests/core/journal-byte-identity.test.js --capture` and committed under
`tests/fixtures/journal-{run,resume,submit}-baseline.jsonl`. The test replays the same three flows
against the new code and byte-compares after normalising only run-varying values (timestamps, ids,
tokens, pids, paths, commit hashes); kinds, keys, values, `seq` and ordering must match exactly. The
representative jobs: `run` and `resume` in implement mode (covers the worktree detail keys and resume's
`session_strategy`), `submit` plain. All three byte-identical after the refactor.

**Setup-failure table (criterion D), `tests/core/setup-failure.test.js`** — each case asserted once
against `openAttempt`, directly against the state root:

| Case | Injected how | Exit | Slot acquire/release | Worktree |
|---|---|---|---|---|
| admission full | `backendLimits: { fake: 0 }` | 14 | 1 / 0 | removed |
| `createJob` throws | patched `store.createJob` | 17 (original) | 1 / 1 | removed |
| `createAttemptDir` throws | patched `store.createAttemptDir` | 17 (original) | 1 / 1 | removed |
| `persistInitFiles` throws | patched `store.getJobDir` (module fn, not a store method — its first store call) | 17 (original) | 1 / 1 | removed |
| worktree already exists | `crypto.randomInt` pinned → deterministic jobId suffix, directory pre-created at the exact path, retried across a second boundary | 23 | 0 / 0 | pre-existing dir left untouched (ticket 90's trap) |

### Discoveries

- **Submit does not journal the launch in the submit process.** The ticket was filed before ticket 92
  landed; since then the worker journals `attempt_created` + `created→running`. The submit baseline
  proves the submit command writes only `job_created` + the worker-launch entry (seq 1–2; seq 3–6 are
  the worker's). `openAttempt` therefore takes `journalLaunch: false` for submit — the ticket's
  `admission: null` cannot be the journaling signal, because admission-less runs must still journal
  (attempt-population tests run without an admission controller).
- **The capacity message differed between run and resume** (`...or use "submit" instead.` vs `Try again
  later.`). Unified to run's wording (mentions submit). Not journaled, not quoted in any doc; no
  exit-code or `status.json` change.
- **Submit's `command.json` diverges from its job mode**: job `mode: 'submit'` but `command.mode:
  'run'`, and `hardTimeoutMs` is `0` when `--hard-timeout-sec` is absent while run/resume use the
  `JOB_HARD_TIMEOUT_MS` default. Preserved via `commandMode` and `hardTimeoutMs` options; nothing reads
  `command.json`, but the fixture keeps it identical anyway.
- **Ordering change for submit**: `prompt.txt`/`params.json` are now written after `createAttemptDir` +
  `persistInitFiles` instead of between `createJob` and `createAttemptDir`. No journal impact (proved by
  the byte-identical baseline); nothing reads those files before the worker starts.
- **Dead code removed**: `parentMode` in `resume.js` (declared, never used).
- `tests/core/setup-cleanup.test.js`, `attempt-population.test.js`, `resume.test.js`, `commands.test.js`,
  `submit-launch-identity.test.js`, `submit-e2e.test.js` and `npm run lint` all green. Per the task
  brief, the full suite was not run; the touched paths are covered by the suites above plus the two new
  ones.
