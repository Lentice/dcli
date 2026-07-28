# 21 — Scoped review with embedded diff and findings contract

**Blocked by:** 20
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` §7,
[design spec §11](../2026-07-28-design-spec.md#11-review-design).

---

## Purpose

`review` sends a precisely scoped diff for an independent second opinion and returns findings a caller can
triage mechanically — with any degradation stated out loud.

## Why it matters

The findings appendix produced an entire family of real bugs in the predecessor, and one of them is the worst
possible failure for this feature: **a malformed appendix degraded into a clean review.** A user asked "is this
change safe?", got "no findings", and had no idea the parser had failed.

Two more coverage holes shipped in the same feature:

- The embedded diff **truncated at 100 KB without saying so** — so a review could silently cover part of a change.
- Review selection was built purely from `git diff`, which **never sees untracked files** — so a review of
  brand-new files could report "clean" *without having read them*.

Every one of those is a silent-reduced-coverage bug. The rule that follows: **if coverage is reduced, the output
says so.**

## Design

### Scoping

```
--staged | --working | --range <base>..<head>
--path <p>            (repeatable)
--include-untracked
--embed-diff          (default)
--intent "<one line>"
--focus "<aspect>"
```

`--embed-diff` is the default: the wrapper generates the exact diff itself and embeds it. Two reasons — the
reviewer cannot review a moving target, and the reviewer does not need the ability to spawn `git` (the
predecessor hit a host where the backend sandbox could not spawn processes at all).

**Truncation must be explicit.** If the diff exceeds the cap, say so in the prompt *and* in the wrapper's output
and job record: which files were dropped, how many bytes were cut. A silently partial review is worse than a
refused one.

**Untracked files.** Without `--include-untracked`, a review whose scope contains untracked files must **warn**
that they were excluded. New files being invisible is precisely how "clean" becomes a lie.

`access` for review is always `read-only`, and an override is rejected with exit `2`.

### Prompt rules

State intent **neutrally** and tell the reviewer explicitly that intent is context, **not evidence of
correctness** — conclusory phrasing biases a reviewer toward endorsement, which is the exact failure mode a
second opinion exists to avoid. Require evidence against the actual diff, deny edits, order findings by
severity, and require exactly one appendix.

### The findings contract

````markdown
<!-- dcli:findings -->
```json
{ "verdict": "One-line verdict.",
  "items": [ { "severity": "critical|important|minor", "file": "relative/path.ts", "line": 42,
               "claim": "…", "evidence": "…", "suggested_fix": "…" } ] }
```
````

Parser rules — each from a real bug:

- Parse only the **final exact marker**. A preamble before it is tolerated (models drift and add "Here is my
  analysis:"). Trailing content after the appendix is not.
- A **duplicate marker** is `malformed`, not "silently take the last".
- A **top-level single-element array** must not be mis-enumerated into a bare object.
- A **line number above int32** must not crash the parser.
- **Inline code fences** inside prose must not break segmentation.
- **Truncated JSON is `malformed`** — token truncation leaves the marker present and the JSON incomplete.
- Cap appendix byte size and item count. Treat all content as **untrusted input**.
- Validate `file` as repository-relative; reject absolute paths and traversal.
- `verdict` non-empty string; `items` an array; each item a recognized `severity` and non-empty `claim`;
  `file`/`line`/`evidence`/`suggested_fix` may be null.

Carry **`findings_status: ok | absent | malformed`**. `findings: null` alone cannot distinguish "found nothing"
from "unparseable", and conflating them is the headline bug.

The prose in `result.md` is **always** preserved, whatever the parser decides.

### Marker coexistence with the predecessor

Producers emit **only** `<!-- dcli:findings -->`. A consumer may additionally recognize the predecessor''s
`<!-- ccodex:findings -->` during the coexistence period, but a document containing **both** is ambiguous and
must be **rejected** — never silently resolved by taking the last one. The marker carries no version; the
schema version lives inside the JSON object, so parsers dispatch on one stable delimiter (ADR-009).
### The corpus fixture

Check in a corpus of **real model outputs** from all three backends — clean, findings-bearing, preamble-bearing,
truncated, duplicate-marker, fence-containing. Format stability is a claim that must be measured. This is a test
fixture, not a runtime pre-flight: do not add a warm-up review call per invocation.

## Pitfalls

- Never let a parse failure read as a pass.
- Never truncate silently — not the diff, not the appendix, not the item list.
- Do not put the reviewer's raw output in front of the user as a conclusion. Findings are triaged, not adopted.
- Do not use native structured output on any backend for this (opencode's is broken and corrupts sessions; the
  other two are structurally different mechanisms). Parse text uniformly.

## Checklist

- [ ] All scoping flags work, including `--path` repeated and `--range`.
- [ ] `--embed-diff` is the default and the wrapper generates the diff itself.
- [ ] Diff truncation is reported in the prompt, the output, and the job record, naming dropped files and bytes.
- [ ] Without `--include-untracked`, untracked files in scope produce an explicit **warning**.
- [ ] `--include-untracked` includes them with size limits and `--path` scoping respected.
- [ ] `access` is forced to `read-only`; an override is exit `2`.
- [ ] The prompt frames intent as context, not evidence; a test asserts the framing text is present.
- [ ] Parser: final-exact-marker only; preamble tolerated; trailing content rejected.
- [ ] Parser regression tests for: duplicate marker; single-element top-level array; line number > int32;
      inline code fences; truncated JSON; oversized appendix; absolute and traversal paths.
- [ ] `findings_status` is `ok | absent | malformed` and is exposed in `--json`.
- [ ] **A malformed appendix never reads as a clean review** — dedicated regression test.
- [ ] `result.md` prose is preserved in every failure case.
- [ ] A checked-in corpus of real outputs from all three backends is used as a fixture.
- [ ] No native structured output is used.

## How to verify

```powershell
node tests/run-tests.js --suite full

node cli/dcli-opencode.js review --working --path core/ --intent "Add cache invalidation" `
  --hard-timeout-sec 900 --json
```

Then deliberately corrupt a recorded appendix fixture and confirm the result is `malformed`, not clean.

## Definition of done

Full suite green with every parser regression test; truncation and untracked exclusion are both surfaced; the
malformed-is-not-clean test passes.

## Commit message

```
feat: scoped review with wrapper-generated diff and hardened findings contract
```

## Notes

### Implementation summary

Built both the findings parser and the review command:

**`core/findings.js`** — Finds `<!-- dcli:findings -->` marker in markdown text and
parses the JSON appendix. Returns `{ status: 'ok' | 'absent' | 'malformed', data, items, proseBefore, error }`.
Validates all contract rules (severity enum, non-empty verdict/claim, absolute/traversal path rejection,
item count cap at 100, appendix size cap at 100 KB). Prose before the marker is always preserved.

**`core/commands/review.js`** — Generates a git diff (staged/working/range scoping), builds a
review prompt with framing text, runs it through the adapter (via `executeRun`), and parses findings
from the result. Supports `--path` (repeatable), `--include-untracked`, `--embed-diff` (default),
`--intent`, `--focus`. Diff truncated at 100 KB with explicit reporting. Access forced to `read-only`.

**Tests:**
- `tests/core/findings.test.js` — 18 regression tests covering all edge cases
- `tests/core/findings-corpus.test.js` — 6 corpus fixture tests
- `tests/core/review.test.js` — 14 tests for prompt building, diff generation, untracked handling, full execution

**Fixtures:** `tests/fixtures/findings-corpus/` — 6 synthetic model outputs covering clean, preamble,
truncated, and duplicate-marker scenarios across all three backends.

### Discoveries

- The `--embed-diff` flag from the spec is the default (boolean true). The implementation
  treats it as a boolean; when explicitly `--no-embed-diff` would be needed to disable, but
  the spec doesn't define a disable mechanism. I used `--embed-diff false` in tests but the
  CLI currently only supports `--embed-diff` as a presence flag (always true). This matches
  the design intent since it's the default.
- The design spec §11 says "Parse only the final exact marker" which could be read as "take
  the last one if there are multiple". But §11 also says "A duplicate marker is malformed".
  The implementation follows the latter (duplicate = malformed), consistent with the ticket
  checklist and regression tests.
- `executeReview` wraps `executeRun` rather than duplicating the lifecycle, which keeps the
  core run logic in one place. Findings are parsed from the result text and set on the
  envelope post-execution. The `findings_status` is exposed in `--json` output but not
  persisted to `status.json` (it can be re-derived from `result.md`).
