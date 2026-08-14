# 123 — remove the opencode automation-policy dead path, and the error that sends callers after a flag that does not exist

**Status:** done
**Blocked by:** —
**Tier:** Cleanup, with one Trust edge. The dead code costs nothing on its own; the two messages on it
cost a caller a debugging session each, because they name a remedy that does not exist. `adapter.js`
tells the caller to "Pass `--automation-policy`", and no such flag is defined anywhere in
`core/cli-args.js`. An agent that hits it will look for the flag, not find it, and conclude the wrapper
is broken.

**Filed from:** a delegated Codex scoping audit (2026-08-13), independently verified. The audit confirmed
the premise: nothing in the product path ever populates the policy. The only assignments in the entire
repository are two test lines that reach into the private field to force a branch the CLI cannot reach.

---

## Symptom / Goal

`adapters/opencode/adapter.js:113` sets `this._automationPolicy = null` and nothing ever assigns it. Every
reader is therefore a branch with one reachable side:

- `adapters/opencode/turn.js:198` — `if (!this._policy)` is always true, so every pending interaction is
  auto-rejected. **That behavior is correct and shipped** (`integration/source/backend-opencode.md`
  documents opencode as unattended-only). What is dead is the unreachable other side.
- `adapters/opencode/adapter.js:503` — `reply === 'always' && !this._automationPolicy` is always true, so
  `reply: always` is always rejected.
- `adapters/opencode/adapter.js:611` — `has_automation_policy` is always `false`.

Goal: the adapter contains no branch on a value that cannot exist, and no message offering a remedy the
CLI cannot provide.

**Decided: remove the dead path, do not complete the wiring.** opencode ships as unattended-only and the
agent skills already tell agents to grant what the task needs up front via `--access`. Completing the
wiring would add a public flag and a persisted request field (roughly fourteen files: CLI help, parser,
four command paths, job setup, `command.json`, submit's `params.json`, the worker's validation payload,
the adapter, tests, reference, and both integration layers) in direct conflict with that shipped
guidance. Removal is six files. Do not reopen this decision inside the ticket.

## Root cause

A responder capability was designed and the transport half was built; the input half never was. The
branches and their messages were written as if the input existed, so the code reads like a feature with a
missing flag rather than a feature that was never wired.

## Binding constraints — quoted, do not go looking for them

The auto-rejection behavior is a shipped contract and must survive this ticket unchanged.
`integration/source/backend-opencode.md`:

> Every pending interaction is rejected automatically, recorded as `rejected_unattended`, and reported as
> a `permission_or_sandbox` backend error.

So `interaction_pending`, `interaction_resolved`, `outcome: 'rejected_unattended'`, and
`class_hint: 'permission_or_sandbox'` keep their exact names and meanings. The audit confirmed nothing
policy-specific is persisted — `backend_state` for a new job carries only `schema_version`
(`core/job-store.js:252`), and `has_automation_policy` lives only in the diagnostics return object, never
in `status.json`. **Removal therefore does not touch the append-only contract.** Verify that yourself
before deleting anything; if you find a persisted policy field the audit missed, stop and say so.

`Respond()` is part of the adapter interface — `adapters/claude/adapter.js`, `adapters/codex/adapter.js`
and `adapters/fake/adapter.js` all implement it. **Do not delete the method.** Only its policy-gated
`always` branch is dead; the `once` / `reject` / question-reply / benign-404 handling is not.

## Files to read and trace first

- `adapters/opencode/adapter.js` — the field (`:113`), the `policy` argument passed to the turn (`:489`),
  the `always` branch and its message (`:503`–`:508`), the diagnostics key (`:611`).
- `adapters/opencode/turn.js` — the `_policy` field (`:69`), the `run()` JSDoc and destructured parameter
  (`:99`, `:105`, `:109`), the `if (!this._policy)` wrapper (`:198`), and the rejection message sent to
  the backend (`:449`).
- `tests/adapters/opencode/interactions-and-classification.test.js` — two blocks assert the "no policy"
  rejection and two lines inject `_automationPolicy` directly (`:192`, `:245`) to force the unreachable
  side. These tests assert the dead path's existence, so they change with it.
- `docs/reference/cli-opencode.md:227` — states `reply: always` "requires explicit `_automationPolicy`",
  documenting a private field as if it were an input.

Line numbers drift; the identifiers above are the spec.

## What to build

### 1. Delete the field and its readers

Remove `_automationPolicy`, the `policy` parameter threaded from `Observe()` into `Turn.run()`, `_policy`,
and the `has_automation_policy` diagnostics key.

### 2. Make the auto-rejection unconditional, not deleted

`turn.js:198`'s wrapper goes away; **everything inside it stays and now runs unconditionally.** This is
the one place where a careless deletion changes behavior — removing the block instead of the condition
would leave interactions unresolved, which is exactly the stall the current design prevents.

### 3. Reject `reply: always` on its own terms

`Respond()` still must not perform a blanket grant. Keep the rejection, drop the policy premise: it is
unsupported for this backend, not blocked pending a flag. The error must not name
`--automation-policy` or any other nonexistent input.

### 4. Fix both outward-facing messages

- `adapter.js:506` — remove the `--automation-policy` instruction entirely.
- `turn.js:449` — the message travels to the backend's permission endpoint and can surface in event logs.
  "Provide an automation policy or run interactively" offers two routes dcli does not have; point at the
  one that exists — granting what the task needs up front via `--access`.

### 5. Documentation in the same commit

- `docs/reference/cli-opencode.md:227` — describe `reply: always` as unsupported, with no reference to a
  private field.
- `integration/source/backend-opencode.md` — the "Interactions are auto-rejected" section currently
  explains the behavior via "the automation policy that would grant a request is never populated". After
  this ticket there is no policy to mention: state the behavior directly (interactions are always
  auto-rejected; grant up front via `--access`). Behavior unchanged, so this is a wording change only —
  but it must ship here, or the skills keep teaching a concept the code no longer contains.
- Regenerate with `node scripts/generate-integration.js`, re-run `install.ps1`, confirm the installed
  `SKILL.md` copies byte-match the repo.

### 6. Tests

The two blocks that assert "rejected without a policy" become "rejected, full stop", and the two
`_automationPolicy` injections go. Do not delete the coverage: the surviving assertions must still prove
`reply: always` is refused and that a pending interaction is auto-rejected with the documented outcome
and class.

## Non-goals

- **Designing or building an automation-policy feature.** Decided against above.
- **Deleting `Respond()`** or its non-policy branches, or touching the other adapters' implementations.
- **Changing the auto-rejection behavior, its event names, or its failure class.**
- **Auditing dead paths in the other two adapters.** If one exists, it is its own ticket.

## Acceptance criteria

- [ ] **A.** `grep -rn "_automationPolicy\|automation-policy\|has_automation_policy" adapters/ core/ cli/ tests/ docs/ integration/source/` returns nothing.
- [ ] **B.** A pending interaction is still auto-rejected with `outcome: 'rejected_unattended'` and a
  `permission_or_sandbox` backend error — proven by the existing test, with only the policy scaffolding
  removed from it.
- [ ] **C.** `Respond()` still refuses `reply: always`, and the error message names no flag or field that
  does not exist.
- [ ] **D.** `Respond()`'s `once`, `reject`, question-reply and 404 paths are unchanged.
- [ ] **E.** No field was removed from `status.json` or `backend_state` (invariant 4) — state in Notes
  what you verified was never persisted.
- [ ] **Z.** `npm run check` green; tracker table regenerated via `node scripts/generate-tickets-table.js`;
  `docs/reference/*` and `integration/source/*` updated in the same commit, with installed skill copies
  verified byte-identical.

## Agent checks

```bash
# The concept is gone from code, tests, and docs:
grep -rn "automation.policy\|_automationPolicy" adapters/ core/ cli/ tests/ docs/ integration/
# expect: no output

# No message points at a flag the parser does not define:
grep -rn "\-\-automation-policy" .
# expect: no output

# The auto-rejection survived as unconditional behavior:
grep -n "rejected_unattended" adapters/opencode/turn.js
# expect: still present, and not inside a policy conditional

# Docs and installed skills agree:
node scripts/generate-integration.js --check
# expect: passes with no drift reported
```

## Notes

Removed the unreachable policy field and all policy threading/readers. Pending interactions remain
unconditionally rejected with the same outcome and class; `reply: always` now reports unsupported
without naming a nonexistent input. No policy field was persisted: new `backend_state` still carries
only its schema version, and diagnostics were not persisted. `Respond()` has no product caller in
`core/`; it remains test-reachable, as scoped. Direct opencode interaction tests pass. Generated and
installed integration skills were verified byte-identical.

**Full suite (2026-08-14).** `npm run check` green apart from a pre-existing flake in
`tests/core/test-runner.test.js` under full-suite load — see ticket 121's Notes for the measurement.
