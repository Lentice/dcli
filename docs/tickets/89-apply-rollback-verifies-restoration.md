# 89 — Apply rollback must verify restoration before reporting failure

**Tier:** Data safety and contract correctness. `apply` is allowed to mutate the user's main repository only when a failed operation can prove that repository state was restored.
**Filed from:** 2026-08-08 repository audit; direct rollback probe.

---

## Symptom / Goal

`core/commands/apply.js` ignores the result of `git reset --hard` during rollback. If that reset fails or times out, `_hardReset()` returns normally and the caller can report the original apply failure without proving that `HEAD`, tracked files, and residual Git state were restored.

The goal is fail-closed rollback: exit `25` is emitted only after restoration is verified, and a failed verification names the non-restoration instead of silently continuing.

## Root cause

`_hardReset()` currently discards the `spawnSync` result:

```js
function _hardReset(repoRoot, preHead, preUntracked) {
  spawnSync('git', ['reset', '--hard', preHead], { cwd: repoRoot, windowsHide: true, timeout: 30000 });
  if (hasResidualGitState(repoRoot)) {
    clearResidualGitState(repoRoot);
  }
}
```

The direct probe passed an invalid ref and a modified tracked file; the helper returned without throwing and left `status: "M a.txt"`:

```text
{"threw":null,"content":"unrestored","status":"M a.txt"}
```

## Binding constraints — quoted, do not go looking for them

From `docs/design-spec.md`:

> `apply` requires a clean main working tree; `--allow-untracked` is an opt-in override for unrelated untracked files only. Tracked dirt, path overlap, or an in-progress am/rebase exit `2`. On conflict, exit `25` **only after verifying** the main repo is restored with no residual git operation.

> `25` | Apply conflict; main repository verified restored

From `docs/engineering/lessons.md`:

> Rollback must not `reset --hard` over changes it cannot prove it owns. Re-check the tree immediately before restoring; if unexpected modifications appeared, **skip the reset and report non-restoration** rather than discarding a user's work.

Preserve exit-code meanings, the existing pre-reset ownership guard, and the no-automatic-apply rule.

## Files to read and trace first

- `core/commands/apply.js` — trace `executeApply`, `_rollbackOrReport`, `_hardReset`, and both error paths that call rollback.
- `core/worktree.js` — reuse its bounded Git invocation and error conventions; do not add a shell command.
- `tests/core/worktree.test.js` — extend rollback coverage beside tests 21–22.
- `tests/core/hard-kill-honesty.test.js` and `tests/helpers/assert-failure.js` — follow the repository's failure-identity assertions.
- `docs/design-spec.md` §13 and `docs/engineering/lessons.md` §8 — preserve the restoration contract quoted above.

## What to build

1. Check the `spawnSync` result for process error, timeout, and non-zero exit; do not treat a failed reset as successful rollback.
2. After any attempted reset/cleanup, verify the expected `HEAD`, tracked status, and residual Git-operation state before allowing the original error to be rethrown.
3. If verification fails, throw exit `25` with a message that states the repository was not verified restored and preserves the original failure context.
4. Add a deterministic regression test that makes the reset fail and asserts the failure identity plus preservation of the unverified repository state.

## Non-goals

- Resetting over newly observed tracked changes — the existing ownership guard must remain fail-closed.
- Changing cherry-pick conflict handling or exit-code vocabulary — the existing contract is append-only.
- Adding a second rollback implementation — keep one shared postcondition in `apply.js`.

## Acceptance criteria

- [x] **A.** A failed `git reset --hard` cannot return from `_rollbackOrReport` as if restoration succeeded.
- [x] **B.** Exit `25` is returned only when restoration and residual-state cleanup are verified; otherwise the error explicitly says restoration was not verified.
- [x] **C.** Existing rollback tests 21–22 remain green and the new failure-path regression passes.
- [x] **D.** `npm run lint` and the affected worktree test pass; no CLI, status field, or exit-code meaning changes.

## Agent checks

```bash
# Run the focused worktree/apply regression suite from a temp root outside this repository.
node tests/core/worktree.test.js
# expect: all worktree tests pass, including rollback and apply verification.

npm run lint
# expect: exit code 0.

# Confirm the implementation still checks the reset result rather than discarding it.
rg -n "spawnSync\('git', \['reset', '--hard'|status|error|timeout|not verified restored" core/commands/apply.js tests/core/worktree.test.js
# expect: the reset failure and restoration postcondition are both represented in code/tests.
```

## Notes

Implemented by opencode as `ticket 89: apply rollback must verify restoration`.

- `core/commands/apply.js` now checks reset process errors, timeouts, and non-zero exits; it verifies `HEAD`, tracked status, and residual Git state through one shared postcondition and reports exit `25` with `NOT verified restored` when proof fails.
- `tests/core/worktree.test.js` adds a deterministic failing-reset regression; existing rollback tests 21–22 remain green.
- `node tests/core/worktree.test.js`: 27 passed; `npm run lint`: exit 0.
- Full-suite failures remained the known environment-only opencode password-environment and headless containment failures; no CLI, status field, or exit-code meaning changed.
- The ticket's cited `docs/design-spec.md` and `docs/engineering/lessons.md` paths are absent in this checkout; the quoted contracts were found in the archived design spec and `AGENTS.md`.

(Left empty by the author. The implementer fills it in with changes, checks, results, deviations, and discoveries.)
