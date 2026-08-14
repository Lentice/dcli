# 130 — `submit --resume` records `fork_from_artifacts` but starts from `HEAD`, and three `apply` flags are missing from every synopsis

**Status:** done
**Blocked by:** —
**Tier:** Correctness, then discoverability. A submitted child job claims in `status.json` to be forked
from its parent's artifacts while its worktree actually starts from the repository's current `HEAD` —
the record and the reality disagree. Separately, `apply` implements three flags that no synopsis
mentions, and `submit --resume` is implemented and documented nowhere at all.

**Filed from:** a two-auditor documentation-accuracy sweep on 2026-08-14. The missing `apply` flags and
the undocumented `--resume` were found by both auditors; the seed-commit divergence was found by the
`dcli-codex` delegation while checking whether the hardcoded strategy was a bug, and confirmed against
`core/commands/resume.js`.

---

## Symptom / Goal

**A. `submit --resume <job-id>` on an implement-mode job forks from the wrong commit.**

`resume --kind fork_from_artifacts` seeds the new worktree from the parent's result commit.
`submit --resume` records the *same* strategy string in `status.json` but passes no seed commit, so the
worktree is created from `HEAD`. The child job therefore starts from the user's current tree rather
than from the parent's work, while its own record says otherwise. Anyone reading the lineage — a user,
or a later `resume` — is told something untrue.

**B. `--resume` is implemented but appears in no help text, no README, no skill, no reference doc.**
`dcli --help` does not list it; `grep -rn -- "--resume" README.md integration/ docs/reference/` finds
nothing. It is a working feature only reachable by reading the parser.

**C. `submit --kind ...` is silently ignored.** `--kind` is a `resume` flag. Passing it to `submit`
does nothing at all — no error, no effect — which reads as "accepted".

**D. Three `apply` flags are undocumented.** `apply` implements `--reset-author`, `--message <s>` and
`--allow-untracked`. The opencode and codex synopses show the first two and omit the third; the claude
synopsis shows none of them.

## Root cause

**A.** `core/commands/resume.js` computes and passes a seed commit:

```js
let parentSnapshotCommit = null;
if (parentStatus.worktree && parentStatus.worktree.result_commit) {
  parentSnapshotCommit = parentStatus.worktree.result_commit;
}
...
seedCommit: kind === 'fork_from_artifacts' && parentSnapshotCommit ? parentSnapshotCommit : null,
```

`core/commands/submit.js` loads the parent status for its group, label, access and root id, records the
strategy — and passes no `seedCommit` to `openAttempt()`:

```js
lineage: resumeJobId
  ? { parentJobId: resumeJobId, sessionStrategy: 'fork_from_artifacts', rootJobId: parentRootJobId || null }
  : null,
```

The hardcoded `'fork_from_artifacts'` is **not** the bug — `submit --resume` is deliberately a single
fixed strategy (a detached artifact fork), while the three-way choice belongs to `resume --kind`. The
bug is that submit implements only half of what that strategy means.

**B/C/D** are omissions: the flags were added to the parser and the command bodies without the help
block, the skills, or the reference docs following.

## Binding constraints — quoted, do not go looking for them

`core/cli-args.js` already routes both flags — neither is being added:

```js
const VALUE_FLAGS = new Set([..., '--message', '--mode', '--kind', '--resume']);
```

`cli/dcli.js`, the `apply` branch, is the ground truth for §4:

```js
const result = executeApply({
  store, repoKey, jobId,
  resetAuthor: parsed.resetAuthor || false,
  message: parsed.message || null,
  allowUntracked: parsed.allowUntracked || false,
});
```

**Invariant 4 is append-only.** `status.json`'s `session_strategy` keeps the value
`fork_from_artifacts` with its existing meaning. This ticket makes the behavior match that recorded
value; it does not add a strategy, rename one, or change what any strategy means.

**Invariant 2 — adapters emit facts, the engine decides state** — is not at risk here, but note that
the seed-commit decision belongs in `core/commands/submit.js`, alongside where `resume.js` makes it,
and not in any adapter.

`integration/generated/**` is produced from `integration/source/**` by
`scripts/generate-integration.js`. Never hand-edit a generated file.

## Files to read and trace first

- `core/commands/submit.js` — the parent-status load, the `lineage` object, the `openAttempt()` call.
  This is where the fix lands.
- `core/commands/resume.js` — `parentSnapshotCommit`, and the `seedCommit:` argument to
  `openAttempt()`. **This is the reference implementation**; match its behavior exactly, including its
  fallback when the parent has no result commit.
- The `openAttempt()` definition — how `seedCommit` is consumed, and what it does when the value is
  `null`. Confirm the `null` path is the create-from-`HEAD` path before relying on it as the fallback.
- `core/worktree.js` — how the base commit is chosen and recorded, so you can assert on it in a test.
- `cli/dcli.js` — the `submit` branch (`resumeJobId: parsed.resume || null`) and the `apply` branch;
  plus the `Options:` help block, which gains `--resume`.
- `tests/core/` — the existing resume/lineage tests; the new submit test belongs beside them and can
  reuse their worktree fixtures.
- `integration/source/backend-opencode.md`, `backend-codex.md`, `backend-claude.md` — the `apply` and
  `resume` sections.
- `integration/source/core.md` — where a shared `submit --resume` description belongs.
- `scripts/generate-integration.js` — the `implement.md` command template carries an `apply` synopsis;
  it is a source file.
- `README.md` and `docs/design-spec.md` §16 — where `--resume` gains its paragraph.

Line numbers drift; the function names and code shapes are the spec.

## What to build

### 1. Give `submit --resume` the same seed commit `resume` uses

In `core/commands/submit.js`, when `resumeJobId` is set and the effective mode is `implement`, read the
parent's result commit exactly as `resume.js` does and pass it as `seedCommit` to `openAttempt()`.

If the parent has no result commit, pass `null` and create from `HEAD` — the same fallback `resume.js`
already takes. **Do not fabricate a commit and do not fail the submit**; a parent that produced no
worktree result is a legitimate case, and `resume` has already settled how it behaves.

The recorded `session_strategy` stays `'fork_from_artifacts'`.

### 2. Document `submit --resume`

Help block in `cli/dcli.js`, beside the other value flags:

```
  --resume <job-id>         Submit a detached child forked from a parent job's artifacts
```

And a paragraph in `README.md`, `docs/design-spec.md` §16, and `integration/source/core.md`:

> `submit --resume <job-id>` creates a **detached** child job with the fixed strategy
> `fork_from_artifacts`: in implement mode its worktree is seeded from the parent's result commit, and
> it inherits the parent's group, label and access unless overridden. It does **not** continue the
> backend session. For conversational continuation use
> `resume <job-id> --kind continue_backend_session`. `--kind` does not apply to `submit`.

### 3. Reject `submit --kind`

A `--kind` passed to `submit` is a usage error: exit `2`, message naming the flag and pointing at
`resume`, no job created. Silent acceptance of a flag that does nothing is how the wrong mental model
survives. Add a test.

### 4. Correct the `apply` synopses

In all three `integration/source/backend-*.md` files and in the `implement.md` template inside
`scripts/generate-integration.js`, the `apply` line becomes:

```
dcli-<backend> apply [--reset-author] [--message <s>] [--allow-untracked] <job-id>
```

A short-form `apply <job-id>` inside a longer background recipe is fine and may stay — only the lines
presented as the command's synopsis must be complete.

Check `docs/reference/cli-*.md` for the same omission and fix it there too.

### 5. Tests

- `submit --mode implement --resume <parent>` where the parent has a result commit: the child's
  recorded worktree base commit **is** that commit.
- The same where the parent has no result commit: the child is created from `HEAD`, the submit
  succeeds, and no commit is invented.
- The recorded `session_strategy` is still `fork_from_artifacts` in both cases — the persisted contract
  did not move.
- `submit --kind continue_backend_session` exits `2` and creates no job.

### 6. Regenerate

`node scripts/generate-integration.js`, committed in the same commit.

## Non-goals

- **Making `submit` accept `--kind` and honor three strategies.** `submit` is deliberately the
  detached-fork entry point; the three-way choice is `resume`'s. Splitting the strategy vocabulary
  across two commands is a design change, not a defect fix.
- **Changing, renaming or adding a `session_strategy` value.** Invariant 4 is append-only. This ticket
  makes the behavior honest about the value it already writes.
- **Continuing the backend session from `submit`.** That is `resume --kind continue_backend_session`,
  which exists.
- **Seeding a run-mode (non-implement) submit.** Run mode has no wrapper-owned worktree to seed.
- **Touching the effort flags, `--access`, `cleanup` or `--embed-diff`.** Same sweep, separate tickets
  (127, 128, 129).

## Acceptance criteria

- [ ] **A.** `submit --mode implement --resume <parent>` creates a worktree based on the parent's
  result commit when the parent has one.
- [ ] **B.** When the parent has no result commit, the submit still succeeds and the worktree is based
  on `HEAD`.
- [ ] **C.** `status.json`'s `session_strategy` is `fork_from_artifacts` in both cases — unchanged.
- [ ] **D.** `submit --kind <anything>` exits `2` with a message pointing at `resume`, and creates no
  job record.
- [ ] **E.** `dcli --help` lists `--resume`.
- [ ] **F.** `README.md`, `docs/design-spec.md` §16 and `integration/source/core.md` describe what
  `submit --resume` does, that its strategy is fixed, that it does not continue the backend session,
  and that `--kind` does not apply.
- [ ] **G.** Every `apply` synopsis shows all three flags.
- [ ] **H.** `node scripts/generate-integration.js --check` reports everything up to date.
- [ ] **Z.** `npm run check` green; the tracker table regenerated via
  `node scripts/generate-tickets-table.js` whenever this ticket's status or blockers changed;
  `README.md`, `docs/reference/*` and `integration/source/*` updated in the same commit where the
  change is user-visible or agent-visible.

## Agent checks

```bash
# submit now makes the same seeding decision resume does:
grep -n "seedCommit" core/commands/submit.js core/commands/resume.js
# expect: both files pass seedCommit to openAttempt

# ...and the persisted contract did not move:
grep -rn "fork_from_artifacts" core/commands/submit.js
# expect: still recorded as the session strategy, unchanged

# The undocumented flag is documented:
grep -rn -- "--resume" cli/dcli.js README.md docs/design-spec.md integration/source/core.md
# expect: at least one match in each

# A --kind on submit is now a usage error, not silence:
echo hi | node cli/dcli.js --backend codex submit --repo . --kind retry_attempt --hard-timeout-sec 60; echo "exit=$?"
# expect: message naming --kind and pointing at `resume`, exit=2

# Every apply synopsis is complete:
grep -rn "apply \[" integration/source/ scripts/generate-integration.js docs/reference/
# expect: every line shows --reset-author, --message and --allow-untracked

# ...and no synopsis line still omits the untracked flag:
grep -rn "apply \[--reset-author\] \[--message <s>\] <job-id>" integration/ docs/ scripts/
# expect: no output

# Generated integration files match their sources:
node scripts/generate-integration.js --check
# expect: "All generated files are up to date."

# The fix stayed in core, out of the adapters:
git diff --name-only | grep "^adapters/"
# expect: no output
```

## Notes

`submit --resume` now reads the parent's `worktree.result_commit` for implement-mode children and passes
it through `openAttempt(seedCommit)`, with the existing HEAD fallback when no result commit exists.
`--kind` on `submit` is now rejected with exit `2` and a pointer to `resume`, before job creation. Added
the help entry and documented the fixed detached `fork_from_artifacts` strategy in the README, design
specification, references, and generated integration sources. Completed all apply synopses with
`--reset-author`, `--message`, and `--allow-untracked`.

Direct checks passed:

- `node tests/core/submit-resume.test.js` — result-commit seed, HEAD fallback, persisted strategy, and
  rejected `submit --kind`.
- `node tests/core/submit-implement-mode.test.js`
- `node tests/core/resume.test.js`
- `node tests/core/cli-args.test.js`
- Targeted ESLint, `node scripts/generate-integration.js --check`, and `git diff --check` passed.

Per the user's instruction, the full `npm run check` was not run.
