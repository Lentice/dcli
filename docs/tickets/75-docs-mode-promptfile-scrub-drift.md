# 75 — Docs drift: README `--mode brainstorm/test` rejected by parser; `--prompt-file` undocumented (the only working resume path); codex/claude cleanup `--scrub-session-ids` drift in skills

**What to build:** the user-facing and agent-facing documentation teaches commands the parser actually accepts. Three classes of drift:
1. README headline examples use `--mode brainstorm` and `--mode test`, which the parser rejects (exit 2) — every agent copying them fails silently.
2. `--prompt-file` is the ONLY working way to pass a resume follow-up prompt today (ticket 56 fixes the pipe path; until then `--prompt-file` is the workaround AND once 56 lands `--prompt-file` remains valid), but no skill, command, or README recipe mentions it. Agents have no documented working way to resume with a follow-up.
3. `integration/source/backend-codex.md` and `backend-claude.md` cleanup sections omit `--scrub-session-ids` while the generated command files include it. The generator's CI staleness check is hash-only and can't detect intra-source drift.

**Blocked by:** Tickets 56 (pipe-resume fix — coordinate doc examples with the fix)

**Status:** ready-for-agent

## Acceptance criteria

### A. README `--mode` examples
- [ ] `README.md` (around line 73, 79): the `--mode brainstorm` and `--mode test` examples are REPLACED with values the parser accepts (`run` or `implement` only — see `core/commands/index.js:221-226`). The examples' intent is preserved (e.g. "brainstorm" → `run` mode with a brainstorm prompt; "test" → submit + a test-running prompt with `--mode run`).
- [ ] All README recipes continue to pass the integration generator's budget check (`scripts/generate-integration.js` line ~360 — wait lines carry `--timeout-sec`).

### B. `--prompt-file` documented as a resume mechanism
- [ ] The resume section in `integration/source/backend-opencode.md`, `backend-codex.md`, `backend-claude.md` (and the generated skills) updates the recipe to show `--prompt-file` for follow-up prompts (showing the piped form works once ticket 56 lands AND `--prompt-file` works always):
  ```
  echo "Follow-up" > followup.txt
  dcli-<backend> resume <job-id> --kind continue_backend_session --prompt-file followup.txt --hard-timeout-sec <n>
  ```
  And once ticket 56 lands, ALSO show the pipe form as the convenience recipe.
- [ ] `cli/dcli.js:29` `--prompt-file <path>` help text gets a one-line clarification that it's the canonical way to provide a follow-up prompt for `resume` (and an alternative to piped stdin for `run`/`submit`/`review`).
- [ ] `--prompt-file` is added to the integration source's command inventory so the generated skills list it. Verify `scripts/generate-integration.js` includes it in the produced reference.

### C. cleanup --scrub-session-ids drift in skills
- [ ] `integration/source/backend-codex.md` (around line 65) and `backend-claude.md` (around line 64) cleanup sections ADD `--scrub-session-ids` to match the generated command files (`integration/generated/commands/dcli-codex/cleanup.md:5`, etc. — both already list it).
- [ ] After fixing the sources, run `node scripts/generate-integration.js` and commit the regenerated skills so the hash-check passes.
- [ ] Add a generator-side assertion (optional follow-up if not trivial): the skill cleanup body must include every flag the corresponding command file lists; fall back to a documented pattern in the skill if a flag is command-file-only. Note this in `scripts/generate-integration.js` if you add it.

### D. Verification
- [ ] `node scripts/generate-integration.js --check` is green (sources match generated).
- [ ] Manual: `dcli-opencode --help` output and `cat integration/generated/skills/dcli-opencode/SKILL.md | grep -A1 prompt-file` — `--prompt-file` is mentioned in the skill.
- [ ] Manual: copy a fixed README example and run it; it returns 0 / produces expected output, NOT exit 2.
- [ ] Full suite green.

## Development guidance

- This is `AGENTS.md` §"Documentation maintenance": "A change is not done until the docs reflect it, in the same commit — never as a deferred task." The README teaches wrong syntax; every agent that follows its headline examples fails silently. The fix is "rewrite the examples so they parse."
- Coordinate with ticket 56's resume fix: 56 fixes the pipe path to be valid; this ticket updates docs so the documented recipes reflect the fix. Either land 56 + 75 together or sequence 75 immediately after 56.
- The `--scrub-session-ids` drift is structural: the generator's check is hash-only on the regenerated tree — it can't detect that the SOURCE `backend-*.md` diverges from its own COMMAND FILE reference table. A real fix would have the generator source-vs-command-cross-check; if you add it, scope it small (just cleanup for this ticket; don't try every command).
- Don't silently drop the cross-backend `wait --all --group nightly` recipe in README (line 79-80 mixes backends) — it's defensible (`wait --all` is backend-agnostic — `cli/dcli.js:238`), just confirm the intent is preserved and keep the example.

## Why it matters

Generated skills are exactly "every future agent session is taught the old behavior" — `AGENTS.md` calls it "the most expensive kind of doc rot in this project, because it is invisible." The `--mode brainstorm/test` examples fail-stop on copy; the resume doc silently sends the wrong thing (ticket 56); the scrub drift teaches agents the cleaner doesn't have a flag it does.

## How to verify

```powershell
node scripts/generate-integration.js --check
node tests/run-tests.js --suite full
# Copy a README example and run it; assert exit 0.
```

## Commit message

```
docs: README `--mode` examples are real, `--prompt-file` documented as the resume path, scrub-session-ids drift fixed in skills
```