# 125 — the runner's own byte-exact test compares a load-dependent section, so a green suite is a coin flip under load

**Status:** in progress
**Blocked by:** —
**Tier:** Trust in the suite itself. `npm run check` is the gate every ticket ships through. When it fails
in `tests/core/test-runner.test.js`, the failure says nothing about the change under test — but a human
has to spend a re-run and a judgement call to learn that. A gate that is occasionally wrong for reasons
unrelated to the diff trains its readers to re-run until green, which is how a real regression gets waved
through.

**Filed from:** ticket 121's Notes (2026-08-14). Measured there: two consecutive `npm run check` runs on
the same tree, first 62/62 green, second 61 passed with this file the only failure; the file passes 3/3
standalone. Recorded at the time as "a pre-existing flake; it deserves its own ticket".

---

## Symptom / Goal

`tests/core/test-runner.test.js` block 1 runs the fixture suite twice through `runTests()` — once at
`concurrency: 1`, once at `concurrency: 3` — and asserts the two outputs are byte-identical after
timings are scrubbed:

```js
const withoutTimings = (output) => output.replace(/\d+ ms \/ \d+ ms/g, '<timing>');
assert.strictEqual(
  withoutTimings(r1.output),
  withoutTimings(r2.output),
  'Output other than measured timings must match at different concurrency',
);
```

Under full-suite load this assertion fails. It passes when the file runs alone, because then the nested
fixture processes are the only thing competing for the machine.

The assertion's *intent* is sound and worth keeping: the runner must report the same results regardless of
how many workers it used. What is wrong is that the comparison includes a section whose entire purpose is
to vary with load.

Goal: the byte-exact comparison covers exactly what is supposed to be concurrency-invariant, and a
`npm run check` failure in this file means the runner is genuinely broken.

## Root cause

Ticket 105 added the near-cap `--- LOAD ---` report to `renderResults()` in `tests/run-tests.js`:

```js
const nearCap = results
  .filter(r => r.timeoutMs > 0 && r.elapsedMs >= r.timeoutMs * NEAR_CAP_FRACTION)
  .sort((a, b) => b.elapsedMs / b.timeoutMs - a.elapsedMs / a.timeoutMs);
if (nearCap.length > 0) {
  lines.push('');
  lines.push('--- LOAD ---');
  ...
  for (const r of nearCap) {
    const pct = Math.round((r.elapsedMs / r.timeoutMs) * 100);
    lines.push(`  ${r.rel}  (${r.elapsedMs} ms / ${r.timeoutMs} ms, ${pct}% of budget)`);
  }
}
```

Three things in that block are load-dependent by design, and none of them survives the scrubber:

1. **Set membership.** `NEAR_CAP_FRACTION` is `0.5`. A fixture that takes 40% of its budget at
   `concurrency: 1` and 55% at `concurrency: 3` appears in one run's list and not the other's. The whole
   section can be present in one output and absent from the other.
2. **Order.** The list is sorted by measured budget fraction.
3. **The percentage.** `withoutTimings` replaces `\d+ ms / \d+ ms`, so the line becomes
   `<timing>, 55% of budget` — the percentage is still raw text and still differs.

So the assertion compares a deliberately non-deterministic report against itself and demands equality.
The flake is not in the runner's behavior; it is in the test's definition of "output".

The file's own header comment already records an earlier round of this — the fixture timeout was raised
from 5 s to 10 s for the same reason — which is evidence that the timeout is not the lever that fixes it.

## Binding constraints — quoted, do not go looking for them

`docs/engineering/testing.md` is required reading for this ticket, and its rule about a flake is the
constraint that decides the shape of the fix: a test that is re-run until green is not a passing test.
Read it before choosing between the options in "What to build".

Ticket 105's near-cap report is a shipped feature and its rationale is in `tests/run-tests.js:14-16`:

> A file using this fraction of its budget is treated as load-stressed and reported in the summary, so a
> run that nearly failed does not look like one that passed comfortably (ticket 105).

**Do not delete or weaken the `--- LOAD ---` report to make the test pass.** It exists because a suite
that squeaks in under its caps used to look identical to one with headroom. Removing it would trade a
noisy test for a silent one, which is the worse of the two.

`NEAR_CAP_FRACTION` is also not the lever: raising it shrinks the set but does not make membership
concurrency-invariant, and lowering it makes the section constant only by making it useless.

## Files to read and trace first

- `tests/core/test-runner.test.js` — block 1, the `withoutTimings` scrubber and the `strictEqual`. The
  other assertions in that block (`fail.test.js` appears, `exit code: 1` reported, the per-file
  `ms / ms` line) are about content, not about equality, and are not implicated.
- `tests/run-tests.js` — `renderResults()`, the `nearCap` computation, `NEAR_CAP_FRACTION`, and where the
  `--- LOAD ---` lines are appended relative to the rest of the summary. Establish exactly which line
  ranges are results and which are the load report; the fix depends on that boundary being clean.
- `tests/fixtures/` — the fixture files whose elapsed times drive membership. Note which ones have a
  file-level timeout override, since those have a different budget and so a different fraction.
- Any other caller of `renderResults()` — if the load report is separated out, everything that renders a
  summary must still show it. `npm run check`'s own output is the one that matters most.
- `docs/engineering/testing.md` — the project's position on flakes and on what a green suite means.

Line numbers drift; the function and constant names above are the spec.

## What to build

One outcome: the comparison is deterministic without the load report becoming invisible. Two viable
shapes; **pick one and record which in Notes, with the reason**.

### Option A — scrub the load section in the test

Extend the normalizer so it drops the entire `--- LOAD ---` block (from the blank line before the header
to the end of that section) before comparing, in addition to the existing timing scrub. Smallest diff.
The cost is that the test then asserts nothing about the load report at all, so add a separate, targeted
assertion that the report renders when a fixture is genuinely near its cap — otherwise this ticket
removes coverage while fixing a flake.

### Option B — separate the report from the results in the renderer

Have `renderResults()` return the deterministic results text and the load report as distinct values, and
let the callers concatenate them for display. The test then compares the deterministic half directly and
never has to know the load section's text shape. Larger diff, touches production-adjacent code, but the
invariant becomes structural instead of maintained by a regex.

Either way:

- The two-concurrency equality assertion stays. It is the thing under test and it is correct.
- The `--- LOAD ---` output must still appear in a real `npm run check` run, unchanged in wording and
  content. Verify this by eye on an actual run, not by reading the code.

### Do not

Raise `FIXTURE_TIMEOUT` again, mark the file `@serial` harder, retry the assertion, or compare with a
tolerance. All four hide the non-determinism instead of removing it, and the timeout lever has already
been pulled once for this exact symptom.

## Non-goals

- **Auditing the rest of the suite for flakes.** This ticket fixes the one that was measured. Another
  file's flake is another ticket, and bundling them means neither gets proven fixed.
- **Changing `NEAR_CAP_FRACTION`, the load report's wording, or its trigger.** Ruled out above; it is a
  shipped diagnostic with a ticket behind it.
- **Making the fixture suite faster or the runner more deterministic in its scheduling.** The runner is
  allowed to schedule differently at different concurrency — that is the point of the parameter. Only the
  *reported results* must match.
- **Adding a retry mechanism to the runner.** A gate that retries is a gate that has stopped gating.

## Acceptance criteria

- [ ] **A.** `tests/core/test-runner.test.js` passes when run as part of a full `npm run check` on a
  loaded machine — demonstrated by three consecutive full-suite runs, all green, recorded in Notes with
  the actual counts. One green run is not evidence for a load-dependent flake.
- [ ] **B.** The two-concurrency byte-equality assertion still exists and still compares the pass/fail
  results, the failure diagnostics, and the per-file timing lines. State in Notes what it now excludes.
- [ ] **C.** A real `npm run check` still prints the `--- LOAD ---` section when a file is at or above 50%
  of its budget, with wording unchanged. Paste the observed section in Notes, or state that no file
  reached the threshold on that run and demonstrate the report another way.
- [ ] **D.** If Option A: a separate assertion proves the load report renders for a near-cap fixture. If
  Option B: `renderResults()`'s callers all still display the report, named in Notes.
- [ ] **E.** `FIXTURE_TIMEOUT` was not raised and no retry, sleep, or tolerance was added to the test.
- [ ] **Z.** `npm run check` green; tracker table regenerated via `node scripts/generate-tickets-table.js`.
  No user-facing or agent-facing behavior changes, so no `README.md` / `integration/source/*` update is
  expected — say so explicitly in Notes rather than leaving it unaddressed.

## Agent checks

```bash
# The flake is load-dependent, so the check is repetition under load, not a single run:
npm run check && npm run check && npm run check
# expect: three greens, with tests/core/test-runner.test.js passing in all three

# The file still passes alone (it always did — this is the control, not the proof):
node tests/run-tests.js --suite full 2>/dev/null | grep -c "test-runner"
# expect: no failure line for this file

# The load report was not deleted to make the test pass:
grep -n "LOAD\|NEAR_CAP_FRACTION" tests/run-tests.js
# expect: the constant, the filter, and the '--- LOAD ---' header all still present

# The banned levers were not pulled:
grep -n "FIXTURE_TIMEOUT" tests/core/test-runner.test.js
# expect: still 10000
grep -niE "retry|setTimeout|sleep" tests/core/test-runner.test.js
# expect: no output
```

## Notes

Implemented Option A in `tests/core/test-runner.test.js`: the concurrency comparison now removes the
entire trailing `--- LOAD ---` section before normalizing timings, while a separate near-cap assertion
still proves that the report renders for `hang.test.js` with its wording and budget details intact.

Scoped checks passed three consecutive times:

- `node tests/core/test-runner.test.js` — `PASS: all test-runner tests` (3/3)
- `npx eslint tests/core/test-runner.test.js` — passed
- `git diff --check` — passed
- A direct runner invocation observed the unchanged load report, including
  `test-runner\\hang.test.js  (1025 ms / 1000 ms, 102% of budget)`.

`FIXTURE_TIMEOUT` remains `10000`; no retry, sleep, or tolerance was added. No `README.md`, reference,
or integration-source update is needed because this is test-only. Per the user's instruction, the full
`npm run check` and its three consecutive full-suite runs were not executed, so this ticket remains
`in progress` pending that gate.
