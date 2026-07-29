# 22 — Worktree isolation: implement, diff, apply

**Blocked by:** 21
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` §8 (this is the ticket that section is about),
[design spec §12](../2026-07-28-design-spec.md#12-isolation-for---mode-implement).

---

## Purpose

A delegated code change is made in an isolated git worktree, the user inspects the diff, and only then can it be
landed — with a rollback that never destroys work it does not own.

## Why it matters

This is the most destructive feature in the tool, and the predecessor found five separate real defects here:

1. A synthetic snapshot commit that ran the user's git hooks, **unbounded** — a hanging pre-commit hook or
   credential helper prevented the job from *ever* becoming terminal, after the hard timeout had already fired.
2. Rollback that ran `reset --hard` over changes it could not prove it owned — a tracked edit saved during the
   apply window was discarded.
3. Residual `git am`/rebase state left behind after a failed apply.
4. `diff`/`apply` offered on a job whose snapshot finalization had failed.
5. Retention cleanup deleting a worktree mid-`format-patch`, destroying the only artifact needed to retry.

And one honesty correction from review: **a worktree is repository-state isolation only.** It stops the backend
mutating the user's checkout. It does **not** stop it reading credentials, keys, or arbitrary files — only the
backend's own sandbox does that. Do not overclaim.

## Design

### `implement`

1. Resolve the repository and `HEAD`; record `base_commit`.
2. Create a **detached** worktree at `<state-root>/worktrees/<job-id>` under the per-repository worktree lock.
3. Reject up front: a nested repository, unresolved conflicts, a dirty precondition where one is required, and
   any path escape.
4. Run the backend with the worktree as its canonical directory (ticket 18 for opencode).
5. On failure at **any** point after creation, tear the worktree down — the `run` path and the `resume` path must
   behave identically here. A past bug had them diverge.

### Snapshot finalization — bounded and hook-free

Stage the intended changes and create a wrapper-owned commit as `result_commit`, using **git plumbing that
bypasses hooks and signing**, with wrapper-controlled author metadata. Concretely: an empty `core.hooksPath`,
signing disabled, and explicit author/committer.

**Bound it with the remaining deadline plus a grace window.** On timeout or failure, record
`worktree_finalize_error` and **still terminalize the job**, preserving a `timed_out` state if that is what it was.
A job must never be stuck because a hook hung.

### `diff`

- `diff <job>` prints `base_commit..result_commit`.
- `--stat` and `--name-only` size the change first. They are **mutually exclusive**; both together is exit `2`.
- **Refuse** if snapshot finalization failed — do not offer a partial artifact.
- Hold the shared job lease for the whole operation (ticket 05).

### `apply`

Preconditions: a clean main working tree; no in-progress `am`/`rebase`; no path overlap.
`--allow-untracked` is an opt-in override for **unrelated** untracked files only; pre-existing untracked files
are preserved. Tracked dirt is always exit `2`.

Take the per-main-repo lock. Then:

1. Record `preHead` and a full `git status --porcelain` snapshot.
2. Transport the recorded commit range.
3. On failure: **re-run `git status --porcelain` before rolling back.** If tracked modifications appeared that
   were not in the pre-apply snapshot, **skip the reset**, report non-restoration explicitly, and tell the user
   to inspect. Otherwise restore to `preHead` and clean only the computed untracked delta.
4. Verify no residual `am`/rebase state remains; clear it if it does, and verify again.
5. Exit `25` **only after** the main repository is verified restored.

`--reset-author` and `--message` reauthor and retitle the single landed commit. On a resumed multi-commit series,
both exit `2` **up front, before the main repo is touched**.

**`apply` never runs automatically.** Not at a policy checkpoint, not unattended, ever.

## Pitfalls

- Never `reset --hard` over an unproven delta.
- Never bound-less any git call in this path.
- `diff`/`apply`/`resume` hold a lease; retention must lose to them (ticket 11).
- Apply only the newest accepted descendant in a follow-up chain — never the ancestor.
- Do not use opencode's native worktree/VCS endpoints here; they are diagnostics-only extensions.

## Checklist

- [ ] Worktree creation is detached, under the per-repository lock, with `base_commit` recorded.
- [ ] Nested repos, unresolved conflicts, and path escapes are rejected up front.
- [ ] Worktree teardown on failure is **identical** for `run` and `resume`; a test asserts parity.
- [ ] Snapshot commit uses plumbing with empty `core.hooksPath`, signing disabled, explicit author.
- [ ] A **hanging-hook fixture** proves finalization is bounded, records `worktree_finalize_error`, and the job
      still terminalizes with its prior state preserved.
- [ ] `diff` prints the recorded range; `--stat` and `--name-only` work; both together is exit `2`.
- [ ] `diff` **refuses** when finalization failed.
- [ ] `diff`/`apply`/`resume` hold the shared lease for the whole operation.
- [ ] `apply` requires a clean tree; tracked dirt is exit `2`; `--allow-untracked` covers only unrelated
      untracked files and preserves pre-existing ones.
- [ ] `apply` takes the per-main-repo lock.
- [ ] **Rollback re-checks `git status` first and skips the reset if unproven modifications appeared**, reporting
      non-restoration — dedicated regression test that plants a tracked edit during the window.
- [ ] Residual `am`/rebase state is cleared **and verified** after a failed apply.
- [ ] Exit `25` is returned only after restoration is verified.
- [ ] `--reset-author`/`--message` work on a single commit and exit `2` up front on a multi-commit series,
      before touching the main repo.
- [ ] A test asserts `apply` has no automatic invocation path anywhere in the codebase.
- [ ] Documentation states a worktree is repository-state isolation only, not access isolation.

## How to verify

```powershell
node tests/run-tests.js --suite full

node cli/dcli-opencode.js run --mode implement --access workspace --hard-timeout-sec 1800 "Add a docstring to core/job-store.js"
node cli/dcli-opencode.js diff <job-id> --stat
node cli/dcli-opencode.js diff <job-id>
node cli/dcli-opencode.js apply --reset-author --message "docs: add docstring" <job-id>
```

## Definition of done

Full suite green including the hanging-hook, unproven-rollback, and residual-rebase tests; `apply` has no
automatic path.

## Commit message

```
feat: worktree-isolated implementation with verified-restoration apply
```

## Notes

Real bugs found during verification, beyond the delivered test suite (fixed before acceptance):

1. **The core `implement` orchestration was never actually wired into `run`/`submit`.** The delivered work
   built and tested `core/worktree.js`, `diff.js`, and `apply.js` as standalone primitives, but
   `cli/dcli.js` had no `--mode` flag and `core/commands/run.js` never created a worktree or ran the
   backend inside one — exactly what this ticket's own "How to verify" section assumes exists. All tests
   passed while the feature was completely unreachable from the CLI. Fixed by adding `--mode implement` to
   arg parsing, and wiring worktree creation (before `Start`), worktree teardown on setup-time failure, and
   bounded snapshot finalization (`finalizeSnapshot`, new `SNAPSHOT_FINALIZE_MS` deadline) into every
   terminal exit path of `executeRun`. This is the single most important lesson from this ticket: **a green
   test suite built entirely from direct function calls does not prove the CLI path exists.** Live end-to-end
   verification (per AGENTS.md's standing rule) is what caught it.

2. **`--allow-untracked` was a dead flag.** `executeApply` accepted it but never referenced it — untracked
   files never blocked `apply` regardless of the flag, contradicting the ticket's own precondition
   ("a clean main working tree"). Fixed by checking `preUntracked.length > 0` unless `allowUntracked` is
   set. This is the same "accepted a flag, never enforced it" class of bug AGENTS.md already warns about.

3. **`isNestedRepo()`'s test was checking the wrong scenario, masked by a Windows path bug.** The delivered
   test independently `git init`'d a subdirectory and expected `isNestedRepo(subdir)` to be true. But
   `isNestedRepo(p)` can only ever detect "`p` is itself a subdirectory of some *outer*, already-registered
   repo" (via `rev-parse --show-toplevel` from `p` returning something other than `p`) — a self-contained
   nested `.git` is legitimately its own toplevel from git's perspective, so the original test's premise was
   backwards. It "passed" only because of an unrelated short/long Windows path string mismatch
   (`LENTIC~1` vs `lenticetsai`) that happened to make the comparison fail for the wrong reason. Fixing the
   real path bug (`fs.realpathSync.native()` + case-insensitive compare, matching the same class of bug
   already documented elsewhere in this project) correctly exposed the test's flawed premise. Rewrote the
   test to construct the actual scenario `isNestedRepo(repoRoot)` guards against in `apply.js`: `repoRoot`
   being a subdirectory of a larger enclosing repo with no `.git` of its own.

4. **opencode server was spawned with no `cwd`**, silently inheriting the wrapper's own working directory
   instead of `canonicalDir`. This had been latent since ticket 14/18 — every prior test and live run
   happened to invoke the CLI from the same directory as `canonicalDir`, so the gap was never exercised
   until ticket 22 introduced the first real scenario (`canonicalDir` = a worktree elsewhere on disk).
   Fixed by passing `cwd: this._canonicalDir` to `spawn()`.

5. **Ticket 18's project-identity guard doesn't understand opencode's own worktree/"sandboxes" model.**
   Even after fix #4, every real implement-mode job against opencode failed with "Project identity
   mismatch." Live reproduction showed: when a git worktree is opened for a project opencode already knows
   about (i.e. the dcli repo itself, used continuously across this whole build), `/project/current` keeps
   returning the *original* registered project directory in its `worktree` field and instead lists every
   known worktree path — including the new one — under a `sandboxes` array. `_verifyProjectIdentity()` only
   ever compared against `project.worktree`, so it rejected every worktree-isolated job as a mismatch, even
   though the server was genuinely running against the correct directory. This is a real gap in ticket 18's
   implementation that could not surface until ticket 22 introduced actual worktree usage. Fixed by also
   accepting a `canonicalDir` match against any entry in `project.sandboxes`. Verified against the real
   opencode 1.18.9 install: a full `run --mode implement` → `diff` → `apply --reset-author --message` cycle
   against a genuine backend now lands cleanly.
