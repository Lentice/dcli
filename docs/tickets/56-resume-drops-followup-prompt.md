# 56 — `resume` falls back to the parent job ID as the prompt; piped/positional follow-ups are silently dropped

**What to build:** `dcli resume <parent-job-id>` resolves the follow-up prompt correctly — from piped stdin, or from positionals after the job ID — instead of using the job ID string itself as the prompt. Ticket 34 documented this exact bug and was closed without the fix being applied (verified: `cli/dcli.js:303-310` is byte-identical to ticket 34's "before" code), so this ticket supersedes 34 with a stronger acceptance bar.

**Blocked by:** None — can start immediately (coordinate with ticket 75 for doc updates)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `cli/dcli.js` resume case (around line 301-338): `parentJobId = parsed.positionals[0]` is extracted AND validated (exit 2 if missing) **before** `resolvePrompt` runs.
- [ ] `resolvePrompt` is called with `positionals: parsed.positionals.slice(1)` (the job ID removed), and `stdinPipeActive` is computed from that sliced array's length being 0, not the original.
- [ ] Test: `echo "X" | dcli-<backend> resume <job-id> --kind retry_attempt --hard-timeout-sec 60` results in the adapter receiving exactly `"X"` as the prompt (verified by an asserted prompt value, not by reading stdout).
- [ ] Test: `dcli-<backend> resume <job-id> continue with X --kind retry_attempt --hard-timeout-sec 60` results in the adapter receiving `"continue with X"`, not `"<job-id> continue with X"`.
- [ ] Test: `dcli-<backend> resume <job-id> --prompt-file followup.md ...` works unchanged (prompt-file path is unaffected by the slice).
- [ ] `core/commands/resume.js:18-22` already throws exit 2 when `parentJobId` is missing — keep that behaviour, just move the extraction earlier in the dispatcher so the prompt isn't resolved against the wrong array.
- [ ] Full suite green.

## Development guidance

- This is ticket 34's design, unchanged, with a verified-against-current-source confirmation that 34's fix never landed. Implement 34's checklist verbatim; the spec there is still correct.
- The single root cause: `resolvePrompt` is called on the full `parsed.positionals` (which still contains the job ID at index 0) before `parentJobId` is sliced off. Reorder so the slice happens first.
- `resolvePrompt` (`core/commands/index.js:286-303`) returns `positionals.join(' ')` whenever `positionals.length > 0` and stdin isn't active. Since resume always needs `positionals[0]` as the job-id, `positionals.length === 0` is never true today, so piped stdin is never read and the job-id string becomes the prompt.
- The `freeText` set in `core/commands/index.js:267` already includes `resume` (correct — resume does accept a positional prompt). Don't remove resume from `freeText`; just ensure the dispatcher slices positionals[0] off before passing the rest to `resolvePrompt`.
- Do NOT change `validatePositionals` to special-case resume; the slice in the dispatcher is the right place. Validation should still accept any positional count ≥ 1 (job-id plus optional prompt words).
- Shims (`dcli-codex.js`, `dcli-opencode.js`, `dcli-claude.js`) just splice `--backend <name>` into argv and `require('./dcli')`; no per-shim fix is needed (ticket 34 flagged this possibility — verified all three shims are pure splice wrappers).

## Why it matters

The README and every backend skill teach the `echo "follow-up" | dcli-<backend> resume <job-id>` pattern. Every agent that follows it resumes the right job with a garbage prompt (the job-id UUID). The only working path today is `--prompt-file`, which no skill mentions. This silently breaks every continuation workflow.

## How to verify

```powershell
node tests/run-tests.js --suite full
node tests/core/resume.test.js
```

## Commit message

```
fix(resume): strip the parent job id from positionals before resolving the follow-up prompt
```