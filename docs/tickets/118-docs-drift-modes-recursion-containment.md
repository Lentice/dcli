# 118 — documentation drift: mode vocabulary, claude recursion guard, containment record timing

**Status:** done
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

**What and where.** Docs only; no code changes.

1. `docs/design-spec.md` §16: replaced "Modes: `review`, `brainstorm`, `test`, `implement`." with the
   shipped vocabulary — `--mode run|implement` (`run` is the default, per `core/cli-args.js:211-218`
   and the `mode === 'implement' ? 'implement' : 'run'` derivations in `core/commands/run.js:5`,
   `submit.js:15`), the recorded `status.mode` values (`run` for the `run` command, `submit` for a
   run-mode submit, `implement` for implement-mode), and "`review` is a subcommand, not a `--mode`
   value". Access paragraph restated to drop the obsolete `brainstorm`/`test` rules; the review
   read-only rule now points to §11.
2. §16 examples block: dropped `--mode brainstorm` and `--mode test` (both exit 2). `run` (default)
   and `submit --access workspace` replace them.
3. `docs/design-spec.md` §5: the `status.json` example recorded `"mode": "review"`, a value that never
   ships; changed to `"run"` (a review-subcommand job records `run`).
4. §14 (2026-08-11 Windows rung-2 amendment): now states the `taskkill-tree` record appears **only
   after a tree-kill rung has run** — spawn-time records are rung-1-only, so a live Windows job
   carries `containment: null` until then — and cross-references §5's `containment_survivors`
   absent-means-never-ran semantics. Matches `adapters/shared/process-lifecycle.js:130-133`,
   `core/cancel.js:135-147`, `core/commands/attempt-driver.js:233-238`, `core/job-store.js:369-373`.
5. `docs/reference/cli-claude.md`: deleted the stale "Nothing in `core/`, `adapters/`, or `cli/`
   implements this yet" paragraph (`:278-279`). The guard ships in `cli/dcli-claude.js:6-18` (env
   sentinel, exit 2) and `adapters/claude/adapter.js:215-218` (stamps `DCLI_WORKER=1`/`DCLI_DEPTH`,
   plus `--safe-mode`/`--disable-slash-commands` at `:47-49`). The section's existing description was
   re-verified and stays; it agrees with `:127` and `:206`.
6. `docs/product-spec.md:172` — deviation, see below.
7. New test `tests/integration/docs-drift-118.test.js` (`@suite full`) gates all three subjects: every
   `--mode` value the spec teaches must survive the real parser (the parser's set is derived from
   `core/cli-args.js`, never hard-coded), the §16 record values, no "implements this yet" anywhere in
   `docs/reference/`, and §14 timing consistent with §5. Red before the doc edits, green after.

**Suite.** `npm run check` green. The first run was killed by a 10-minute wrapper timeout mid-suite
(live integration tests spawn real processes); re-run to completion: `eslint .` clean; `test:full` —
adapters 34, contract 2, core 62, helpers 1, integration 4, 0 failed. The runner's load guard flagged
`core\test-runner.test.js` at 69% of its 120 s budget (82 s) — near-cap, not a failure.

**Agent checks (actual output).**
- `rg -n "brainstorm|test\`|Modes:" docs/design-spec.md` → only line 35 ("brainstorming" as a
  supported work kind, not a mode). No `--mode brainstorm`/`--mode test` example; the obsolete Modes
  sentence is gone.
- `rg -n "implements this yet" docs/reference/` → nothing.
- `rg -n "taskkill-tree|tree-kill rung" docs/design-spec.md` → §5:250 and the §14 amendment both tie
  the record to a rung having run; no "present while running" reading remains.

**Deviations / discoveries.**
1. The ticket's claim that no code rejects a `review` access override is wrong:
   `core/commands/review.js:37-41` rejects `--access` != `read-only` with exit `2`, and the sentence
   already sits in §11 (Review design). Per the Non-goals ("if a doc claim turns out to be true in
   code after all, leave both alone and say so"), both were left as-is.
2. `docs/product-spec.md:172` carried the same §16 mode-vocabulary drift but is outside the ticket's
   named scan list (`integration/source/*`, `docs/reference/cli-*.md`); fixed in the same commit as
   the same drift.
3. `docs/design-spec.md` §5 example `"mode": "review"` is drift #1 in a location the ticket did not
   name; fixed.
4. `integration/source/core.md:146-156` containment text was scanned and left alone: it describes the
   record in the post-escalation context (survivors, exit 21, `kill_skipped`) and does not claim the
   record is present while running, so it is consistent with the code's timing. No generated/installed
   integration copies byte-differ (acceptance Z) — `integration/source/*` was untouched and
   `tests/integration/generate.test.js` regenerates-and-compares the generated tree.
