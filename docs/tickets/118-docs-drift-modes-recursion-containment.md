# 118 — documentation drift: mode vocabulary, claude recursion guard, containment record timing

**Status:** ready
**Blocked by:** —
**Tier:** Spec and reference text that describe behavior the code does not have teaches every
future agent session the wrong contract — the most expensive kind of doc rot here, because it is
invisible. Three verified instances.
**Filed from:** 2026-08-11 dual-backend audit (claude F-4, codex F-10, claude F-7; each verified
against the tree at `51e2d35`)

---

## Symptom / Goal

Three places where `docs/` claims behavior that does not ship:

1. **Mode vocabulary (§16 and the review rule).** `docs/design-spec.md` §16 says: "Modes:
   `review`, `brainstorm`, `test`, `implement`." The parser accepts only `run` and `implement`
   (`core/cli-args.js:206-213`); `--mode brainstorm` exits 2, and the §16 example at `:832`
   ("dcli-opencode run --mode brainstorm") is unrunable. The recorded `status.json` mode value
   for a run-mode submit is `submit` (`core/commands/submit.js:15-16`), a value the spec never
   shows. Separately, `docs/design-spec.md` (line ~553) says "`access` for `review` is always
   `read-only`; a user override is rejected with exit `2`" — `review` is a subcommand, not a
   `--mode` value, and no code rejects such an override, so the sentence reads as a contract
   nothing implements.
2. **Claude recursion guard.** `docs/reference/cli-claude.md:274` says: "Nothing in `core/`,
   `adapters/`, or `cli/` implements this yet" — but `cli/dcli-claude.js:6-15` implements the
   `DCLI_WORKER`/`DCLI_DEPTH` guard and `adapters/claude/adapter.js:215-218, 40-41` stamps those
   variables and adds safe-mode flags. The paragraph predates the implementation.
3. **Containment record timing (§14).** `docs/design-spec.md` §14 amendment (2026-08-11) says:
   "The job record carries `containment: { kind: 'taskkill-tree', degraded: true }` plus the new
   `containment_survivors` field." On Windows, `containmentRecordForThisSpawn()` returns
   `undefined` (`adapters/shared/process-lifecycle.js:129-132`), so a live Windows job's record
   carries `containment: null`; the record is written only when a tree-kill rung has actually run
   (`core/cancel.js:125-137`, `core/commands/attempt-driver.js:233-238`), and the
   `containment_survivors` field's documented semantics are "absent means no tree-kill rung ran
   at all" (`core/job-store.js:372-374`). "Carries" reads as "present while running", which would
   contradict the absent-means-never-ran semantics.

## Root cause

Behavior was narrowed (modes), added (recursion guard) and re-timed (containment record) without
amending the documents that described the older state.

## Binding constraints — quoted, do not go looking for them

`AGENTS.md`: "**Docs ship in the same commit as the behavior** ... `docs/reference/*` for command
and contract tables, and `integration/source/*` whenever a command, flag, or behavior changes
that an agent should know." — this ticket is the catch-up for changes that shipped without their
docs.

`docs/design-spec.md` §5: "`containment_survivors` is written only when a taskkill-tree rung
(ADR-010 rung 2) ran: ... (empty means "verified nothing survived within the enumerated set",
absent means no tree-kill rung ran)." — the amended §14 text must stay consistent with this.

## Files to read and trace first

- `docs/design-spec.md` — §16 modes/access paragraph (`:820-827`) and the examples block
  (`:829-841`); the review read-only sentence (~`:553`); the §14 amendment (`:718-743`).
- `core/cli-args.js:206-213` — the actual `--mode` accepted set (the new spec text must match it
  exactly).
- `core/commands/submit.js:12-16` — how `status.mode` values are derived (`run`/`submit`/
  `implement`).
- `docs/reference/cli-claude.md:258-276` — the recursion-guard section with the stale paragraph.
- `cli/dcli-claude.js:6-15` and `adapters/claude/adapter.js:40-41, 215-218` — the implemented
  guard (the reference must describe this).
- `adapters/shared/process-lifecycle.js:121-132`, `core/cancel.js:125-137`,
  `core/commands/attempt-driver.js:233-238` — the actual containment-record timing.
- `integration/source/*` and `docs/reference/cli-*.md` — scan for the same three drifts
  (especially any `--mode` values beyond `run`/`implement` and any scrub/containment claims).

## What to build

1. **§16 modes.** Replace "Modes: `review`, `brainstorm`, `test`, `implement`." with the shipped
   vocabulary: `--mode run|implement` (`run` is the default), the `status.mode` record values
   (`run` for the run command, `submit` for a run-mode submit, `implement` for implement-mode),
   and a sentence that `review` is a subcommand, not a mode. Fix or drop the `run --mode
   brainstorm` example. Move the review read-only sentence (~`:553`) next to the `review`
   command's documentation (or restate it as applying to the review subcommand, where the CLI
   reference documents it).
2. **cli-claude.md recursion guard.** Delete the "Nothing in `core/`, `adapters/`, or `cli/`
   implements this yet" paragraph (`:274`); the section's existing description of the guard
   (`:258-265`) is already accurate — re-verify it against `cli/dcli-claude.js` and the adapter
   stamps and adjust only if it drifts. Ensure the same section agrees with `docs/reference/
   cli-claude.md:127` and `:206` (which already assert the guard ships).
3. **§14 containment record.** Amend the amendment: state that on Windows the record appears
   **when a tree-kill rung has run** (spawn-time records are rung-1-only; Windows spawns carry
   `containment: null` until then), and cross-reference the §5 `containment_survivors`
   semantics so "carries" cannot be read as "present while running".
4. **Scan the rest of the docs** (`integration/source/*`, `docs/reference/cli-*.md`) for the
   same three drifts and fix any instance found — one commit, all three subjects.

## Non-goals

- **No code changes.** If a doc claim turns out to be true in code after all, leave both alone
  and say so in Notes.
- **No renaming or repurposing of contracts** — this ticket only makes text match the shipped
  behavior; where behavior is ambiguous, the shipped behavior wins and the text records it.

## Acceptance criteria

- [ ] **A.** §16 lists exactly the modes the parser accepts and the `status.mode` values that
  ship; no spec example uses an unrunable `--mode` value.
- [ ] **B.** `docs/reference/cli-claude.md` contains no "not implemented" claim that the code
  contradicts (grep for "implements this yet" and "not implemented" across `docs/reference/`).
- [ ] **C.** §14's amendment text is consistent with §5's `containment_survivors` semantics and
  with the code's record timing.
- [ ] **Z.** `npm run check` green (the tracker table regenerated); no generated/installed
  integration copies byte-differ from `integration/source/` after the change.

## Agent checks

```bash
# What this proves: no spec text claims a mode the parser rejects.
rg -n "brainstorm|test`|Modes:" docs/design-spec.md
# expect: no `--mode brainstorm` example; the Modes sentence names run/implement only

# What this proves: the stale recursion-guard paragraph is gone.
rg -n "implements this yet" docs/reference/
# expect: (nothing)

# What this proves: §14 and §5 agree on when the containment record exists.
rg -n "taskkill-tree|tree-kill rung" docs/design-spec.md
# expect: every mention is consistent with "written when a rung has run"
```

## Notes

(Left empty by the author. The implementer fills it in: what was changed and where, build and suite
results, the Agent checks' actual output, any deviation from this ticket and why, and anything
discovered that contradicts the docs.)
