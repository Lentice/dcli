# 106 — worker-liveness §6g is flaky: corrupt-projection regeneration depends on file mtime ticks

**Status:** done
**Blocked by:** —
**Tier:** Test reliability — the suite's green/red verdict is a coin flip on the wall clock; a
regression in the corrupt-projection path could be masked or, more likely, the suite fails spuriously
on a loaded machine.
**Filed from:** ticket 98's Notes, 2026-08-11 — discovered while running `tests/core/worker-liveness.test.js`
during the split of `core/commands/index.js` (pre-existing, not caused by the move).

---

## Symptom / Goal

`tests/core/worker-liveness.test.js` §6g ("a missing or corrupt projection does not erase the job")
fails intermittently at:

```
AssertionError: a corrupt projection must be regenerated, not reported as an unreadable job
  actual: undefined, expected: true   (row for liveness-12 missing from executeList().jobs)
```

Same machine, same code, no changes: passes on some runs, fails on others. A 20-iteration probe
reproduced failure 11 times.

## Root cause

The test seeds a running job, then overwrites `status.json` with garbage:

```js
seedRunningJob(store, 'liveness-12', {});
fs.writeFileSync(path.join(store.getJobDir(REPO_KEY, 'liveness-12'), 'status.json'), '{ not json', 'utf8');
```

`JobStore.listJobRecords()` (`core/job-store.js`) decides whether the projection is stale — and must be
replayed from the journal — by comparing mtimes:

```js
projectionStale = fs.statSync(journalPath).mtimeMs >= fs.statSync(statusPath).mtimeMs;
```

For a *corrupt* projection the parse then throws and the job lands in `errors` (unreadable, exit-17
material) unless `projectionStale` was already true. But the test writes the corrupt `status.json`
*after* the journal, so the comparison is only true when the two writes land on the same mtime tick
(observed: `delta=0.000ms` when it passes, `3–20ms` when it fails). The test outcome is therefore a
race between the journal write and the corrupt write inside one mtime tick — the probe showed both
outcomes on the same code.

## Files to read and trace first

- `tests/core/worker-liveness.test.js` §6g — the failing block.
- `core/job-store.js` `listJobRecords()` — the `projectionStale` mtime comparison and the
  parse-failure → `errors` path.

## What to build

A fix that makes the *corrupt-projection* case deterministic regardless of mtimes. Options, cheapest
first:

1. In the test, after writing the corrupt `status.json`, rewrite the journal (or bump its mtime, e.g.
   `fs.utimesSync(journalPath, ...)`) so `journal.mtimeMs >= status.mtimeMs` is guaranteed. Smallest
   diff; keeps the store's comparison as the behavior under test.
2. In `core/job-store.js`, treat an unparseable `status.json` as stale *before* the mtime comparison —
   parse when `!projectionStale`, and on `JSON.parse` failure fall back to replay rather than
   `errors`. This is a behavior change to the store (an unreadable-but-corrupt projection becomes
   self-healing), so it needs its own judgment and possibly a design-spec note; the current
   errors-path for corrupt status.json is deliberate (corrupt journal is an error, corrupt projection
   is... currently whichever the mtime says).

Either is fine; pick one and state the decision in Notes. The test's intent (6g's comment) is that a
corrupt projection is replayable from the journal.

## Non-goals

- Not related to ticket 98's module moves; do not fold this into it.
- Not a change to the exit-17 semantics for *unreadable* records — only the corrupt-projection race.

## Acceptance criteria

- [ ] **A.** `node tests/core/worker-liveness.test.js` passes 20 consecutive runs.
- [ ] **Z.** `npm run check` green, in the same commit as the fix.

## Agent checks

```bash
for i in 1 2 3 4 5; do node tests/core/worker-liveness.test.js || exit 1; done
# expect: "All worker liveness tests passed." every run
```

## Notes

**Decision: option 1** — test-side fix. In §6g, after writing the corrupt `status.json`, bump the
journal's mtime (`fs.utimesSync`, target `Date.now() + 1000`) so `journal.mtimeMs >= status.mtimeMs`
is guaranteed and the store's stale branch (replay) is taken deterministically. The store's mtime
comparison stays the behavior under test.

Why not option 2 (store-side: treat an unparseable `status.json` as stale before the mtime
comparison and fall back to replay):
- The ticket orders option 1 as the cheapest diff and it keeps the store's comparison as the
  behavior under test.
- Option 2 is a behavior change in `core/job-store.js`: a corrupt-but-fresh projection flips from
  the exit-17 `errors` path to self-healing replay. The ticket itself flags that this needs its own
  judgment and possibly a design-spec note, and the non-goal bars touching exit-17 semantics for
  unreadable records — this ticket is scoped as test reliability.
- In real operation the journal is appended before `status.json` is regenerated, so the projection
  is normally the newer file; the flake was purely a fixture artifact (the corrupt write landing
  after the journal).

Evidence:
- Before: a 10-run probe reproduced the §6g failure 4 times (runs 2, 7, 8, 10), consistent with the
  ticket's observed 11/20.
- After: acceptance criterion A — 20 consecutive runs, zero failures. Agent checks — 5 consecutive
  runs, "All worker liveness tests passed." every run. `npm run lint` clean.
- Criterion Z (`npm run check` full green) is deferred to the integration verification phase per the
  runner's instruction; this change is confined to `tests/core/worker-liveness.test.js` (no
  `core/` change), so the rest of the suite is not affected.
