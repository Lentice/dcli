# 45 — `cli/dcli.js` ignores `DCLI_STATE_ROOT` whenever `--repo` is given

**Blocked by:** None — can start immediately
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), ADR-009 in `AGENTS.md` ("Environment variables have
declared classes" — `DCLI_STATE_ROOT` is a declared runtime override).

---

## Purpose

`DCLI_STATE_ROOT` must win over the `--repo`-derived default (`<repo>\.dcli-state`) whenever it is set,
so a caller that cannot or should not write state inside the target repository can redirect it.

## Why it matters

A real `dcli-claude review --repo <path> ...` invocation against an external repo (RestCue) with
`DCLI_STATE_ROOT` set to a temp directory still tried to create
`<repo>\.dcli-state\locks\admission` and failed with `EPERM: operation not permitted, mkdir ...`. The
caller had deliberately redirected state to a scratch directory specifically to avoid writing into the
target repo, and the override was silently discarded.

## Evidence (verified live)

```
$dcliReviewState = Join-Path $env:TEMP 'restcue-dcli-review'
New-Item -ItemType Directory -Force -Path $dcliReviewState | Out-Null
$env:DCLI_STATE_ROOT = $dcliReviewState
dcli-claude review --repo D:\Documents\GitHub\RestCue --working --include-untracked --access read-only ...
# → EPERM: operation not permitted, mkdir 'D:\Documents\GitHub\RestCue\.dcli-state\locks\admission'
```

Root cause, `cli/dcli.js` (before fix):

```js
const stateRoot = parsed.repo
  ? path.resolve(parsed.repo, '.dcli-state')
  : (process.env.DCLI_STATE_ROOT || path.join(getStateRoot(), 'test'));
```

When `--repo` is present, `DCLI_STATE_ROOT` is never even consulted — the ternary short-circuits to the
repo-derived path unconditionally.

## Current state of the tree

**A fix is already sitting uncommitted in the working tree** (drafted during live diagnosis of the bug
above, not yet turned into a proper ticket commit):

```js
// DCLI_STATE_ROOT is an explicit runtime override and must win even when a
// repository is supplied. This is required for callers that cannot write
// inside the target repository (and keeps state placement independently
// configurable from repository resolution).
const stateRoot = process.env.DCLI_STATE_ROOT
  || (parsed.repo ? path.resolve(parsed.repo, '.dcli-state') : path.join(getStateRoot(), 'test'));
```

This flips the precedence correctly, but as of this writing it has:
- **No test.** `tests/core/commands.test.js` sets `DCLI_STATE_ROOT` in every existing test, but none of
  those tests also pass `--repo` — so no existing test would have caught the original bug or would catch
  a regression.
- **No commit.** `git diff HEAD -- cli/dcli.js` shows it as an uncommitted working-tree change.
- **No AGENTS.md/README cross-check** that this doesn't contradict the documented environment-variable
  classes (ADR-009) — it doesn't (`DCLI_STATE_ROOT` is already a declared runtime override), but that
  should be stated explicitly in the commit, not left implicit.

## Design

- Keep the precedence already drafted: `DCLI_STATE_ROOT` (if set) > `--repo`-derived `.dcli-state` >
  default test root.
- Add a regression test in `tests/core/commands.test.js` (or a new focused test file) that sets **both**
  `DCLI_STATE_ROOT` and `--repo` and asserts state is written under `DCLI_STATE_ROOT`, not under
  `<repo>\.dcli-state`.
- Verify this doesn't regress any existing test that relies on the repo-derived default when
  `DCLI_STATE_ROOT` is unset.

## Pitfalls

- Don't just accept the uncommitted diff as-is — it has no test, and per `AGENTS.md` ("TDD order: write
  failing tests → verify red → implement → verify green"), the test must be written and shown to fail
  against the pre-fix precedence first.
- Don't scope this fix to `review` only — the same `stateRoot` line in `cli/dcli.js` is shared by every
  subcommand dispatch, so the regression test should not be review-specific.

## Checklist

- [ ] Regression test added: `DCLI_STATE_ROOT` + `--repo` together → state root is `DCLI_STATE_ROOT`.
- [ ] Test fails against the pre-fix precedence, passes against the fix (TDD red/green verified).
- [ ] Existing tests that rely on the repo-derived default (no `DCLI_STATE_ROOT` set) still pass.
- [ ] The already-drafted fix in `cli/dcli.js` is reviewed, kept (or adjusted), and committed.
- [ ] Full suite green.

## How to verify

```powershell
node tests/run-tests.js --suite full
$tmp = Join-Path $env:TEMP 'dcli-ticket45-check'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$env:DCLI_STATE_ROOT = $tmp
node cli/dcli.js --backend fake --repo . run --hard-timeout-sec 30 "test"
Get-ChildItem $tmp\jobs -ErrorAction SilentlyContinue   # must exist
Get-ChildItem .dcli-state -ErrorAction SilentlyContinue # must NOT have been created by this run
```

## Definition of done

`DCLI_STATE_ROOT`, when set, always wins over the `--repo`-derived default state root, with a regression
test proving it, and the fix is committed (not left as an uncommitted working-tree diff).

## Commit message

```
fix: let DCLI_STATE_ROOT override the --repo-derived state root
```
