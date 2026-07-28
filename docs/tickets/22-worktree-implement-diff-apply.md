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
