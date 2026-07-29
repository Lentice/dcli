# 34 — `resume` must not let the job ID leak into the follow-up prompt

**Blocked by:** None — can start immediately
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` "The nine mistakes" #6
(validate before you convert/act — order matters).

---

## Purpose

`dcli-<backend> resume <job-id> [prompt...]` (and its piped-stdin form) must resolve the follow-up prompt
from the arguments **after** the job ID is removed, not from the full positional list.

## Why it matters

Right now, both the piped and positional forms of `resume` send corrupted follow-up prompts, because
`resolvePrompt` is called on the **full** `parsed.positionals` array — which still includes the job ID at
index 0 — before `parentJobId` is extracted.

## Evidence (verified via code read)

`cli/dcli.js` around line 297:

```js
const stdinPipeActive = !process.stdin.isTTY && parsed.positionals.length === 0 && !parsed.promptFile;
const prompt = await resolvePrompt({ promptFile: parsed.promptFile, stdinPipeActive, positionals: parsed.positionals });
const parentJobId = parsed.positionals[0];   // ← extracted AFTER prompt was already resolved
```

Consequences:
- `echo "continue with X" | dcli-codex resume JOB` — since `positionals.length` is 1 (`JOB`), not 0,
  `stdinPipeActive` is false, so the piped stdin is **ignored** and the prompt becomes just `"JOB"`.
- `dcli-codex resume JOB continue with X` — the prompt becomes `"JOB continue with X"`, sending the job ID
  as part of the instruction text.

Any generated recipe (e.g. in the worker-prompts/skills) that pipes a follow-up instruction into `resume`
is silently sending the wrong thing.

## Design

- Extract and validate `parentJobId = parsed.positionals[0]` **first**, reject with exit 2 if missing (as
  the code already does further down — just reorder it earlier).
- Resolve the prompt from `parsed.positionals.slice(1)`, and compute `stdinPipeActive` from *that* sliced
  array's length being 0 (not the original array's).
- This is the same "validate before you convert/act" ordering bug class called out in `AGENTS.md` mistake
  #6 — apply the same fix shape used elsewhere in the codebase for prompt/positional resolution.

## Pitfalls

- Don't just fix the piped-stdin case and leave the positional-args case still concatenating the job ID —
  both forms share the same root cause and need the same fix.
- Double-check `dcli-codex.js`/`dcli-opencode.js`/`dcli-claude.js` shims (if they have their own arg-parsing
  wrappers around the shared `cli/dcli.js` logic) for the same pattern.

## Checklist

- [ ] `parentJobId` is extracted and validated before prompt resolution runs.
- [ ] Prompt resolution (both piped-stdin and positional-args forms) operates on positionals with the job
      ID already removed.
- [ ] `stdinPipeActive` is computed from the post-slice positional length, not the original.
- [ ] A regression test: `echo "X" | dcli-<backend> resume JOB --kind ...` results in the adapter receiving
      exactly `"X"` as the prompt, not `"JOB"`.
- [ ] A regression test: `dcli-<backend> resume JOB continue with X --kind ...` results in the adapter
      receiving `"continue with X"`, not `"JOB continue with X"`.

## How to verify

```powershell
node tests/run-tests.js --suite full
node tests/core/resume.test.js
```

## Definition of done

Full suite green; both piped and positional follow-up prompts reach the adapter with the job ID correctly
stripped, verified by test.

## Commit message

```
fix: resume strips the parent job id from positionals before resolving the follow-up prompt
```
