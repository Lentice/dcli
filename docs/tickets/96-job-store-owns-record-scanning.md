# 96 — `JobStore` owns record scanning; three commands stop reaching into `store._stateRoot`

**Tier:** Correctness of the exit-3 / exit-17 contract. "What counts as a corrupt record" is decided
three times, differently, in three commands that each rebuilt the directory walk by hand.
**Filed from:** architecture review, 2026-08-10 (two of three reviewers independently; the
reach-throughs were verified by grep against the tree at `adcbac1`).

---

## Symptom / Goal

Four modules reach past `JobStore`'s interface into its private state:

```
core/commands/apply.js:26     path.join(store._stateRoot, 'jobs', repoKey)
core/commands/cleanup.js:202  path.join(store._stateRoot, 'jobs')
core/commands/cleanup.js:203  path.join(store._stateRoot, 'worktrees')
core/commands/cleanup.js:226  store._atomicWriteJsonWithRetry(statusPath, record.status)
core/commands/list.js:6       path.join(store._stateRoot, 'jobs')
core/commands/submit.js:12    stateRoot = stateRoot || store._stateRoot
```

Three of them then rebuild the same directory walk — `list.js`, `cleanup.js` and `apply.js`
(`checkNoAppliedDescendant`) each have their own — and the three disagree on what an unreadable record
means. That disagreement is not cosmetic: it is the carrier of the exit-3 versus exit-17 distinction,
which `docs/design-spec.md` §7 spells out at length precisely because it has been got wrong before.

`cleanup.js:226` is the worst of them: it calls a private atomic-write helper, so retention writes
status records through a path that bypasses whatever `JobStore` does around its own writes.

Goal: `JobStore` gains a scanning interface deep enough that the three walkers can be deleted, and the
corruption judgement lives in one place.

## Root cause

`JobStore` exposes per-job reads (`readStatus`, `regenerateStatus`, `reconcileStatus`) but nothing for
"enumerate the records". Every command that needed to enumerate went around the interface, and each
then had to invent its own answer to "this directory exists but its record will not parse".

## Binding constraints — quoted, do not go looking for them

From `docs/design-spec.md` §7, exit `3`:

> Absence must be **proven by `ENOENT`/`ENOTDIR`**, never inferred from a failed stat:
> `fs.existsSync()` returns false for *any* stat error, including the `EPERM`/`EBUSY` Windows hands out
> on a tree being written or scanned, so it cannot tell "no such job" from "could not look". A
> directory that exists but whose record cannot be read is **`17`**, not `3` — exit 3 tells an agent to
> stop looking.

> | `17` | Lock acquisition or corrupt-state failure |

That paragraph is the specification for the new interface. Whatever `listJobRecords()` returns must let
a caller distinguish "absent" from "could not look", with absence proven by errno.

From `docs/design-spec.md` §4 (State root and job layout): the on-disk layout is a contract. This ticket
does not change it — it stops three commands from re-deriving it.

## Files to read and trace first

- `core/job-store.js` — `_stateRoot`, `_jobDir`, `_regenerateStatus`, `readStatus`,
  `_atomicWriteJsonWithRetry`. What is genuinely private versus what callers actually need.
- `core/commands/list.js` — walker, and its handling of a record with no journal.
- `core/commands/cleanup.js` — walker, its handling of a bad status, the worktrees directory, and the
  `_atomicWriteJsonWithRetry` call. Ticket 82's Notes cover orphan-worktree discovery; keep it working.
- `core/commands/apply.js` — `checkNoAppliedDescendant()`, the third walker; it scans for descendants
  by `parentJobId`.
- `core/commands/submit.js` — the `stateRoot` fallback; the cheapest fix here is an accessor.
- `core/locking.js:324` — also reads `store._stateRoot`, to site the lock directory. Decide explicitly
  whether this becomes an accessor too, and say so in Notes.
- `tests/core/job-lookup-errors.test.js`, and the `list` / `cleanup` suites — these pin the current
  per-command behaviour, and are where the three answers will be seen to converge.

## What to build

### 1. `JobStore` scanning interface

```js
listJobRecords({ repoKey = null, group = null }) -> { records, errors }
```

- `records` — readable records, each `{ jobId, repoKey, status, jobDir }`.
- `errors` — unreadable entries, each `{ jobId, repoKey, jobDir, reason }`, where `reason`
  distinguishes proven-absent (errno `ENOENT`/`ENOTDIR`) from could-not-read. Callers that must exit
  `17` read this array; they no longer re-derive the judgement.

```js
findJobs({ parentJobId }) -> records
```

for `apply`'s descendant check.

```js
get stateRoot()          // read-only accessor, replacing the `_stateRoot` reach-throughs
writeStatusRecord(...)   // the supported path for cleanup's status rewrite
```

### 2. Delete the three walkers

`list.js`, `cleanup.js` and `apply.js` consume `listJobRecords` / `findJobs`. `cleanup.js` stops calling
`_atomicWriteJsonWithRetry` and calls the supported write instead.

### 3. One suite for corruption judgement

Table-driven against `listJobRecords`: missing journal, unparseable status, directory present but
unreadable, `ENOENT` mid-scan. Today each of those is asserted (or not) separately per command.

## Non-goals

- **Redesigning `JobStore` into an intent-oriented lifecycle interface** (create attempt / complete
  attempt / request cancellation). One reviewer proposed it; it is a much larger change that touches the
  journal vocabulary, and invariant 4 makes that expensive. This ticket only closes the enumeration
  seam. If the larger change is still wanted afterwards, it gets its own ticket with its replacement
  contract text written in advance.
- **Changing the on-disk layout**, any `status.json` field, or any exit code.
- **Changing what `cleanup` deletes.** Ticket 82 settled that; this ticket changes only how it finds it.

## Acceptance criteria

- [ ] **A.** No file outside `core/job-store.js` references `store._stateRoot` or
  `store._atomicWriteJsonWithRetry`.
- [ ] **B.** `list.js`, `cleanup.js` and `apply.js` contain no `fs.readdir` over the jobs directory.
- [ ] **C.** A record whose directory exists but whose status cannot be read produces exit `17`, not
  `3`, from every command that encounters it — asserted for `list`, `cleanup` and `apply`.
- [ ] **D.** Absence is proven by errno, not by `existsSync`. There is no `existsSync` on the scan path.
- [ ] **E.** `cleanup` still discovers and reports orphan worktrees, and still skips worktrees held by a
  reader — ticket 82's behaviour is unchanged.
- [ ] **F.** `list` output is byte-identical before and after, for a fixture state root containing one
  good record, one corrupt record and one orphan worktree.
- [ ] **Z.** `npm run check` green.

## Agent checks

```bash
# No reach-throughs remain.
grep -rn "_stateRoot\|_atomicWriteJsonWithRetry" core/ cli/ | grep -v "^core/job-store.js"
# expect: nothing (or only core/locking.js, if that decision was recorded in Notes)

# The walkers are gone.
grep -n "readdir" core/commands/list.js core/commands/cleanup.js core/commands/apply.js
# expect: no readdir over the jobs directory

# Absence is proven, not inferred, on the scan path.
grep -n "existsSync" core/job-store.js
# expect: nothing on the listJobRecords path

npm run check
# expect: green
```

## Handoff

**Extra reading, beyond `AGENTS.md` and `00-onboarding.md`** — `docs/design-spec.md` §4 (state root and
job layout) and §7 (exit `3` and `17`, quoted above), plus **ticket 82's Notes**
(`82-cleanup-orphans-worktrees.md`) for the orphan-worktree behaviour that must survive. Nothing else.

**Implementation order:**

1. **Write down the three walkers' corruption judgements side by side** before changing anything, in
   Notes: what `list`, `cleanup` and `apply` each do with a missing journal, an unparseable status, and
   an unreadable directory. Where they disagree, the §7 rule quoted above decides — an existing
   directory whose record cannot be read is `17`, never `3`.
2. Build the fixture state root: one good record, one corrupt record, one orphan worktree. Snapshot
   `list` output against it (criterion F is a byte comparison to this snapshot).
3. Write the corruption-judgement suite against `store.listJobRecords()`, which does not exist yet.
   Verify red.
4. Implement `listJobRecords`, `findJobs`, the `stateRoot` accessor and `writeStatusRecord` on
   `JobStore`.
5. Convert the callers one at a time — `list.js`, then `apply.js`, then `cleanup.js` (the hardest, it
   also touches worktrees) — running the suite after each.
6. Delete the walkers and the `_atomicWriteJsonWithRetry` call last.

**Running tests while you work:**

```bash
node tests/core/job-lookup-errors.test.js
node tests/core/job-store.test.js
npm run check
```

**Traps specific to this ticket:**

- **Never use `fs.existsSync` on the scan path.** §7 spells out why: it returns false for *any* stat
  error, including the `EPERM`/`EBUSY` Windows returns for a tree being written. Absence must be proven
  by an `ENOENT`/`ENOTDIR` errno. This is criterion D and it is the whole point of the ticket.
- `cleanup` walks **two** directories — `jobs` and `worktrees`. Orphan-worktree discovery has no job
  record to scan, so `listJobRecords` alone will not cover it; give it its own accessor or method rather
  than reintroducing a raw path join.
- `cleanup` skips worktrees held by a reader, under the repository lock and job lease. That interaction
  is subtle and already correct — move the enumeration, not the locking.
- `core/locking.js:324` also reads `store._stateRoot`. Decide explicitly whether it uses the new
  accessor, and record the decision in Notes either way. Do not leave it undecided.

**Commit message:**

```
ticket 96: job store owns record scanning
```

## Notes

(Left empty by the author.)
