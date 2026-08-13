# 121 — a failed backend run exits 1, but every document says it exits 10

**Status:** done
**Blocked by:** —
**Tier:** Trust. Exit codes are the delegating agent's entire branching surface. The one code that names
the commonest failure — the backend ran and failed — is documented in the design spec, in `README.md`,
and in all three installed agent skills, and cannot be produced by the implementation. An agent that
switches on it takes the wrong branch every time.

**Filed from:** a delegated Codex audit of `integration/source/` (2026-08-13). The audit's other five
findings were documentation defects and were fixed in that commit; this one is an implementation gap and
was split out. Verified against the code before filing.

---

## Symptom / Goal

`docs/design-spec.md` §7 defines exit `10` as "Backend/provider execution failed (see `failure_reason`)",
and the failure-class reference table that ships to agents repeats it as the reaction rule for a backend
execution failure. No code path produces it.

A job whose backend ran and failed without a named failure class — the ordinary case — exits `1`. Exit
`1` is documented nowhere. An agent following the shipped table finds no row for what it actually
received, so it cannot distinguish "the backend tried and failed" from "the wrapper itself broke".

Goal: exit `10` is either reachable for the failure it names, or the contract stops claiming it exists.
The first is almost certainly correct — that is what the spec decided — but this ticket must not assume
it without checking who depends on the current `1`.

## Root cause

`core/failure-class.js` owns the mapping and has no entry for `10`:

```js
const FAILURE_CLASS_TO_EXIT_CODE = Object.freeze({
  environment: 12,
  authentication: 13,
  quota_or_rate_limit: 14,
  permission_or_sandbox: 15,
  network_error: 16,
  lock: 17,
  protocol: 26,
});
```

so the terminal mapping special-cases two reasons and falls through to `1`:

```js
function terminalExitCode(state, failure, failureReason) {
  if (state === 'done' || state === 'interrupted' || state === 'cancelled') return 0;
  if (failureReason === 'hard_timeout') return 24;
  if (failureReason === 'result_persistence_failed') return 11;
  return FAILURE_CLASS_TO_EXIT_CODE[(failure && (failure.class || failure.class_hint)) || failureReason] || 1;
}
```

Every `failed` attempt that carries no recognized class — including `backend_exited_no_result`, the
reason `classifyTerminalFailure` assigns to a backend that exited non-zero with nothing usable — lands
on that `|| 1`.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §7:

> | `10` | Backend/provider execution failed (see `failure_reason`) |
> | `11` | No usable assistant result |

Also §7, on this table:

> Append-only contract: adding a class or a code is allowed, changing an existing value is not.

So `10` may be made reachable, and `11`'s existing meaning must not be widened to absorb it. `11` is
"the backend produced nothing usable"; `10` is "the backend's execution failed". A run that failed *and*
produced nothing must keep resolving to exactly one of them, and this ticket decides which — see below.

`core/failure-class.js` header, which this ticket must not violate:

> This module must never *classify* (design-spec §8 — a bare number is not a discriminator); it only maps
> an already-named class to its contract code and back.

The new code must therefore come from a *named* class, not from a numeric guess inside the mapper.

## Files to read and trace first

- `core/failure-class.js` — `FAILURE_CLASS_TO_EXIT_CODE`, `classifyTerminalFailure`, `terminalExitCode`.
  The mapping and the fallback both live here. Note that `FAILURE_CLASSES` is derived from the frozen
  literal, so adding a class also adds it to whatever validates against that list.
- Every caller of `terminalExitCode` — find them all before changing the fallback; the commonest failure
  here is fixing the mapper and missing a command that already compensates for the `1`.
- `core/reducer.js` — where a terminal attempt's `failure` / `failure_reason` projection is decided. If a
  backend execution failure has no named class today, this is where the name has to come from.
- `adapters/*/adapter.js` — what the adapters actually emit as facts on a failed run. Adapters emit
  facts; the engine decides state (invariant 2), so the class must not be minted in an adapter.
- `core/commands/read.js` — ticket 115 made `read` exit `11` without a result. Confirm the split between
  `10` and `11` decided here does not silently change what `read` returns.
- `tests/contract/` — the exit-code contract tests. Whatever they currently assert about a failed
  backend run is the behavior other tests were written against.

Line numbers drift; the function names above are the spec.

## What to build

### 1. A named failure class for backend execution failure

Add one class to `FAILURE_CLASS_TO_EXIT_CODE` mapping to `10`. Name it after the condition, in the
existing style of the literal (`environment`, `network_error`); the class name enters `status.json`, so
it is a contract the moment it ships — choose it once, and record the choice in Notes.

### 2. The engine names it

The reducer's terminal projection assigns that class when the attempt failed and the failure is
attributable to the backend's own execution — the backend started, ran, and ended in failure — and no
more specific class (auth, quota, permission, network, environment, protocol, lock) applies. Decided:
the class is assigned in the reducer, not in an adapter and not inside `failure-class.js`.

### 3. `11` keeps its narrower meaning

Decided: `11` stays "no usable result" and continues to win when the distinguishing fact is the missing
or unusably small result — that is what `NO_RESULT_BYTE_THRESHOLD` and `result_missing` already detect,
and ticket 115 depends on it. `10` covers a failed execution that is not merely an empty result. State
the resulting precedence order explicitly in a comment where the decision is made.

### 4. What `1` still means

After this change, exit `1` must mean only "an unclassified wrapper-side error", not "the backend
failed". Either document `1` in §7 with that meaning, or ensure no terminal job resolution can reach it.
Say which was done and why in Notes.

### 5. Agent-visible docs in the same commit

`integration/source/core.md`'s failure-class table already lists `10`; verify its reaction rule matches
the behavior this ticket ships, add a row for whatever `1` now means if it remains reachable, then
regenerate with `node scripts/generate-integration.js`, re-run `install.ps1`, and confirm the installed
`SKILL.md` copies byte-match the repo.

## Non-goals

- **Changing `11`, `24`, or any other existing code's meaning.** The contract is append-only, and `11`'s
  current behavior has a ticket (115) depending on it.
- **Auditing whether exits `18` and `26` are reachable.** `18` is produced by
  `attempt-driver.js`; `26` is out of scope here and deserves its own ticket if it turns out to be dead.
  Widening this ticket into a full exit-code reachability sweep is how it stops shipping.
- **Adding a numeric fallback that guesses a class from an exit code.** Explicitly forbidden by the
  module's own contract (design-spec §8).

## Acceptance criteria

- [ ] **A.** A job whose backend ran and failed with no more specific failure class exits `10`, proven by
  a test that drives the fake adapter to that failure and asserts the process exit code.
- [ ] **B.** A job whose backend produced no usable result still exits `11`; the test that proved this
  before the change still passes unmodified.
- [ ] **C.** No terminal job resolution reaches exit `1` unless `1` is documented in `docs/design-spec.md`
  §7 with a stated meaning.
- [ ] **D.** The new failure class appears in `status.json.failure.class` for that job, and
  `exitCodeToFailureClass(10)` returns it.
- [ ] **E.** No backend-specific conditional was added to `core/` (invariant 1) and no adapter assigns
  the new class (invariant 2).
- [ ] **Z.** `npm run check` green; the tracker table regenerated via
  `node scripts/generate-tickets-table.js`; `README.md`, `docs/reference/*` and `integration/source/*`
  updated in the same commit, with installed skill copies verified byte-identical.

## Agent checks

```bash
# 10 is now in the mapping and round-trips to a named class:
node -e "const f=require('./core/failure-class');console.log(f.exitCodeToFailureClass(10))"
# expect: the new class name, not null

# The fallback no longer silently swallows a backend failure — no bare '|| 1' left
# without a documented meaning:
grep -n "|| 1;" core/failure-class.js
# expect: either no match, or a match with an adjacent comment naming what exit 1 means

# No adapter mints the new class (invariant 2):
grep -rn "<new class name>" adapters/
# expect: no output

# No backend name leaked into the engine while doing this (invariant 1):
grep -rniE "codex|opencode|claude" core/failure-class.js core/reducer.js
# expect: no output

# Docs and installed skills agree:
node scripts/generate-integration.js --check
# expect: passes with no drift reported
```

## Notes

Added the `backend_execution_failed` class at exit `10` and assign it in the reducer for
unclassified backend failures. Added `no_result` at exit `11`; the result-size/missing-artifact
classifier gives it precedence over the generic backend execution class. Exit `1` remains the
documented unclassified wrapper-side fallback. Direct failure-class, backend-failure, envelope,
worktree, and opencode tests pass; full suite was intentionally not run per the implementation
request. Generated and installed integration skills were verified byte-identical.
