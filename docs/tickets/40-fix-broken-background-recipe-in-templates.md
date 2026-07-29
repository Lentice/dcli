# 40 — Fix the broken "background a long task" recipe in the source templates

**Blocked by:** 38 (a real generation-drift check should also catch this class of bug going forward)
**Status:** done (commit 2ab0ec6)
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` mistake #1 (every recipe needs both
budgets and must actually work), ticket 24 ("What each skill must teach").

---

## Purpose

Fix the "background a long task and gather later" recipe in `integration/source/backend-opencode.md` (wrong
backend name in the `submit` line) and in all three per-backend templates (`opencode.md`, `codex.md`,
`claude.md`) where the `submit` call omits the `--group` flag that the following `wait --all --group`
line depends on — then regenerate.

## Why it matters

These are **installed, agent-facing instructions** — exactly the kind of doc bug `AGENTS.md` calls the most
expensive kind of rot, because it's invisible until an agent actually follows the recipe and it silently
does the wrong thing (or hangs waiting on a group nothing was ever submitted under).

## Evidence (verified via source read)

`integration/source/backend-opencode.md` line 106 (rendered into
`integration/generated/skills/dcli-opencode/SKILL.md:180`):

```powershell
"Run the full test suite and report failures." |
  dcli-claude submit --mode test --access workspace --hard-timeout-sec $budget   # ← wrong backend: dcli-claude inside the opencode skill
dcli-opencode wait --all --group nightly --timeout-sec 3600 --json               # ← waits on "nightly" but submit never used --group nightly
```

The same missing-`--group`-on-submit pattern (submit has no `--group nightly`, but the paired `wait` waits
on `--group nightly`) also appears in `integration/source/backend-codex.md` (~line 82–83) and
`integration/source/backend-claude.md` (~line 89–90) — those two at least use the correct backend name for
themselves, but the group mismatch means the `wait` line has nothing to actually wait for.

## Design

- In `integration/source/backend-opencode.md`: change the `submit` line to invoke `dcli-opencode submit` (matching
  its own skill), not `dcli-claude submit`.
- In all three templates (`backend-opencode.md`, `backend-codex.md`, `backend-claude.md`): add `--group nightly` to the `submit`
  call in this recipe, so the paired `wait --all --group nightly` actually has a matching job to find.
- Regenerate (`node scripts/generate-integration.js`) and verify `--check` (ticket 38) reports no drift
  afterward.
- While in this recipe, double check every other generated recipe for the same "submit and wait use
  mismatched flags/backend" pattern — this was found by inspection, not exhaustive lint, so a quick pass
  over all recipes in all three templates plus `router.md` is worthwhile before closing this ticket.

## Pitfalls

- Fix the **source** templates in `integration/source/`, never hand-edit the generated
  `integration/generated/` files directly — they'll be silently overwritten (and ticket 38's real diff
  check should now catch anyone who tries).
- Don't just patch the one recipe found in review — grep all three templates for `submit` and `wait --all`
  pairs and confirm the backend name and `--group` value actually match in each.

## Checklist

- [x] `integration/source/backend-opencode.md`'s background-task recipe invokes `dcli-opencode submit`, not
      `dcli-claude submit`.
- [x] All three templates' background-task recipe passes `--group nightly` on the `submit` call to match
      the subsequent `wait --all --group nightly`.
- [x] A grep across all three source templates confirms no other `submit`/`wait --all --group` pair has a
      mismatched backend name or group value.
- [x] Regenerated `integration/generated/` files are checked in and `node scripts/generate-integration.js
      --check` reports no drift.
- [x] (If ticket 38 has landed) a lint rule or test specifically checks that every `submit` + `wait --all
      --group` recipe pair in the generated skills uses a consistent backend and group value, so this class
      of bug can't silently reappear.

## How to verify

```powershell
node scripts/generate-integration.js
node scripts/generate-integration.js --check
node tests/run-tests.js --suite full
```

## Definition of done

Full suite green; generation reports no drift; the background-task recipe in every generated skill uses
the correct backend name and a matching `--group` value between `submit` and `wait`.

## Commit message

```
fix: correct backend name and group flag in the background-task recipe templates
```

## Notes (discovered while implementing)

The recipe carried a **third** defect this ticket did not name: `--mode test`. `--mode` accepts only
`run` or `implement` (`core/commands/index.js:222`), so the recipe exited 2 before any of the
backend/group problems could matter. The same class appeared in `ask.md` for all three backends, which
taught `run --mode brainstorm` — also rejected. Both were verified by running the documented commands.

Closing this ticket by inspection would have left those in place, so the "quick pass over all recipes"
step was done programmatically instead of by grep. Four tests now enforce the whole class, in
`tests/integration/generate.test.js`:

- every documented `--mode`/`--access`/`--kind` value is fed to the real `parseArgs`, so a doc cannot
  teach a value the CLI rejects. (Note: `parseArgs` only parses flags once a backend *and* subcommand
  are resolved — `parseArgs(['run', ...])` leaves `command === null` and asserts nothing. The test
  guards itself against that by first requiring a known-bad value to be rejected.)
- no backend's documentation invokes another backend's shim.
- every documented `wait` carries `--timeout-sec`, and never in optional brackets.
- every `submit`/`wait --group` pair inside one fenced block is self-consistent.

The staleness checker gained the wait-budget and cross-shim gates too, since it previously only grepped
for the presence of `--hard-timeout-sec` and so proved nothing about the wait budget.

Also renamed `integration/source/{claude,codex,opencode}.md` to `backend-*.md`: on Windows,
`claude.md` and `CLAUDE.md` are the same filename, and Claude Code was discovering the claude backend's
reference data as directory-scoped *project instructions*. Generated output is byte-identical after the
rename. Guarded by test 11.
