# 88 — Remove unused imports from tests and helpers

**Tier:** Test signal and maintainability. Dead test imports obscure which fixtures and helpers a test actually exercises and add noise to future lint cleanup.
**Filed from:** 2026-08-08 repository import audit.

---

## Symptom / Goal

The test tree contains imported bindings that are never read. The normal lint gate does not report them because `no-unused-vars` is intentionally disabled. Remove only the verified unused test imports below without changing setup, assertions, fixtures, concurrency, or test selection.

## Root cause

The same-file ESLint audit reports these unused imported bindings:

```text
tests/adapters/codex/cmd-quoting.test.js: path, execSync
tests/adapters/opencode/adapter.test.js: validateFact
tests/core/attempt-population.test.js: VALID_KINDS, execFileSync
tests/core/backend-failure-reason.test.js: VALID_KINDS
tests/core/commands-tail-debug-cleanup.test.js: TERMINAL
tests/core/commands.test.js: parsePrompt, execFileSync
tests/core/fault-injection.test.js: makeBaseState, assertNoLocks, TERMINAL
tests/core/locking.test.js: spawn
tests/core/process-identity.test.js: crypto, path, fs
tests/core/review.test.js: UNTRACKED_SIZE_LIMIT
tests/core/worker-hard-timeout.test.js: isProcessAlive
tests/core/worktree.test.js: isGitRepo, hasUnresolvedConflicts, isDirty, validateTree, stageAll, snapshotCommit, clearResidualGitState, getUntrackedFilesFromStatus, getTrackedChangesFromStatus, revParse
tests/helpers/fault-injection.js: path
tests/integration/generate.test.js: os, generate
```

These are import bindings only. Other unused locals, parameters, and catch bindings reported by the same audit are outside this ticket because they may represent unasserted results or require behavioral review.

## Binding constraints — quoted, do not go looking for them

From `docs/engineering/testing.md`:

> Tests are plain assertion scripts checked by exit code — no test-runner framework.

> Test false greens are real and have shipped. A whole commit was needed to fix tests that passed while asserting nothing. Prefer assertions on observable artifacts: exit code, byte-exact stdout, and on-disk job state.

> Rules that are off say why, inline. `no-fallthrough` and `no-unused-vars` are currently `'off'` with their violation counts and reasons recorded in the config. Do not silently drop a rule, and do not enable one red.

This ticket removes dead imports only. It must not weaken assertions, alter the test runner, enable `no-unused-vars`, or mask remaining unused locals with disable comments.

## Files to read and trace first

- `eslint.config.js` — confirm the temporary audit rule and current lint policy.
- `tests/adapters/codex/cmd-quoting.test.js` and `tests/adapters/opencode/adapter.test.js` — preserve adapter import/error assertions.
- `tests/core/attempt-population.test.js`, `tests/core/backend-failure-reason.test.js`, `tests/core/commands.test.js`, `tests/core/commands-tail-debug-cleanup.test.js`, `tests/core/fault-injection.test.js`, `tests/core/locking.test.js`, `tests/core/process-identity.test.js`, `tests/core/review.test.js`, `tests/core/worker-hard-timeout.test.js`, and `tests/core/worktree.test.js` — trace each destructured helper against its call sites before editing.
- `tests/helpers/fault-injection.js` and `tests/integration/generate.test.js` — preserve fault injection and generation checks while removing only the listed bindings.
- `tests/run-tests.js` — use it to run the same test selection and confirm no files were skipped.

## What to build

1. Remove exactly the unused imported bindings listed above, retaining every used binding from shared destructuring declarations.
2. Do not delete assertions, helper implementations, fixtures, test sentinels, or unrelated unused locals.
3. Keep the tests in CommonJS form and preserve the existing runner commands and output contracts.

## Non-goals

- Enabling `no-unused-vars` — remaining unused locals and parameters need a separate false-green review.
- Removing unused runtime imports — ticket 87 handles that scope.
- Converting `require` calls to ESM or normalizing `node:` prefixes — neither is required for this defect.
- Rewriting tests to add coverage — this ticket changes only module-loading declarations.

## Acceptance criteria

- [x] **A.** The fourteen listed test files contain none of the unused import bindings in Root cause.
- [x] **B.** `npm run lint` remains green without changing `eslint.config.js` or adding disable comments.
- [x] **C.** The affected tests pass through `node tests/run-tests.js --suite full` where the environment permits temporary directories.
- [x] **D.** Test assertions, fixtures, selection, and observable output are unchanged except for removal of dead imports.

## Agent checks

```bash
# Re-run the focused audit and confirm no Root-cause import binding remains.
npx --no-install eslint tests/adapters/codex/cmd-quoting.test.js tests/adapters/opencode/adapter.test.js tests/core/attempt-population.test.js tests/core/backend-failure-reason.test.js tests/core/commands.test.js tests/core/commands-tail-debug-cleanup.test.js tests/core/fault-injection.test.js tests/core/locking.test.js tests/core/process-identity.test.js tests/core/review.test.js tests/core/worker-hard-timeout.test.js tests/core/worktree.test.js tests/helpers/fault-injection.js tests/integration/generate.test.js --rule '{"no-unused-vars":["error",{"args":"none"}]}'
# expect: any remaining diagnostics are non-import locals/parameters outside this ticket; none names a Root-cause binding.

npm run lint
# expect: exit code 0.

node tests/run-tests.js --suite full
# expect: every test group passes and the runner exits 0.
```

## Notes — 2026-08-09

Implemented and committed by opencode as `ticket 88: remove unused imports from tests and helpers`.

Changed only module-loading declarations in the fourteen files named in Root cause:

- `tests/adapters/codex/cmd-quoting.test.js` — removed unused `path` require; removed the unused `execSync` require in the section-9 sentinel (the two comments that described that import were removed with it; the `PASS: Single implementation verified by import pattern` sentinel is unchanged).
- `tests/adapters/opencode/adapter.test.js` — removed unused `validateFact` import.
- `tests/core/attempt-population.test.js` — dropped `VALID_KINDS` from the `executeResume` destructure; removed unused `execFileSync` require.
- `tests/core/backend-failure-reason.test.js` — dropped `VALID_KINDS` from the `executeResume` destructure.
- `tests/core/commands-tail-debug-cleanup.test.js` — removed unused local `TERMINAL` constant.
- `tests/core/commands.test.js` — removed unused `parsePrompt` import (and its naming comment); removed unused `execFileSync` require.
- `tests/core/fault-injection.test.js` — dropped `makeBaseState` and `assertNoLocks` from the helper destructure; removed unused local `TERMINAL` constant.
- `tests/core/locking.test.js` — dropped `spawn` from the `child_process` destructure, keeping `spawnSync`.
- `tests/core/process-identity.test.js` — removed unused `crypto`, `path`, and `fs` requires, keeping `os`.
- `tests/core/review.test.js` — dropped `UNTRACKED_SIZE_LIMIT` from the `core/commands/review` destructure.
- `tests/core/worker-hard-timeout.test.js` — removed unused `isProcessAlive` import.
- `tests/core/worktree.test.js` — dropped the ten unused helpers (`isGitRepo`, `hasUnresolvedConflicts`, `isDirty`, `validateTree`, `stageAll`, `snapshotCommit`, `clearResidualGitState`, `getUntrackedFilesFromStatus`, `getTrackedChangesFromStatus`, `revParse`) from the `core/worktree` destructure.
- `tests/helpers/fault-injection.js` — removed unused `path` require.
- `tests/integration/generate.test.js` — removed unused `os` require and the unused `generate` binding from the `generate-integration` destructure.

No assertions, fixtures, selection, or observable output were changed.

Checks:

- Focused `no-unused-vars` audit over the fourteen files: only the pre-existing non-import locals remain (`jobDir` in `commands-tail-debug-cleanup.test.js` and `fault-injection.test.js`, `env` in `commands.test.js`, `prompt` in `review.test.js`, `flags` in `generate.test.js`) — none names a Root-cause binding.
- `npm run lint` passed (exit 0).
- `node tests/run-tests.js --suite full`: all thirteen affected test files passed; the suite's only two failures (`adapters/opencode/start-server-scope.test.js` password-environment assertion and `core/containment.test.js` requiring the native helper) were confirmed pre-existing by re-running the full suite on the pristine tree with the change stashed — both are environmental and unrelated to this ticket.
- The isolated worktree required `npm ci` before the lint gate could run; `node_modules/` is gitignored and not part of the commit.

Discovery: the ticket text labels `TERMINAL` in `commands-tail-debug-cleanup.test.js` and `fault-injection.test.js` as "import bindings", but they are module-local constants. They are unused and explicitly named in Root cause, so they were removed to satisfy acceptance criterion A; the remaining unused locals are untouched per the ticket's scope boundary.
