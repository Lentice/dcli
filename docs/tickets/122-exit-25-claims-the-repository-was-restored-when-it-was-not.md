# 122 — exit 25 promises the repository was restored, and is also returned when it provably was not

**Status:** ready
**Blocked by:** —
**Tier:** Trust. `apply` is the one command that writes to the engineer's own working tree, and exit `25`
is the only signal the caller gets about what state that tree was left in. The contract promises
"verified restored" and instructs the agent to resolve and retry. Four of the six throw sites mean the
opposite — the repository was **not** verified restored — and the agent reacts to them identically. A
retry against a half-applied working tree is the most expensive mistake this tool can cause.

**Filed from:** a delegated Codex audit of the exit-code contract (2026-08-13). Verified against the code
before filing. Sibling of ticket 121, which covers a different defect in the same table (exit `10`
unreachable, fallback `1` undocumented); the two must not be merged.

---

## Symptom / Goal

`docs/design-spec.md` §7 defines `25` as:

> | `25` | Apply conflict; main repository verified restored |

and the agent-facing table shipped in all three skills (`integration/source/core.md`) repeats the
reaction rule:

> | 25 | Apply conflict | Main repo verified restored. Resolve and retry. |

Two distinct outcomes exit `25`:

**Restored.** `core/worktree.js:312` — a cherry-pick failed, `cherry-pick --abort` ran, the tree is back.
`core/worktree.js:342` — the apply commit failed before anything landed. Here the documented reaction is
correct.

**Not restored, and the code says so in its own message.** `core/commands/apply.js:150` (reset
deliberately skipped to preserve unexpected tracked modifications), `:170` (`git reset --hard` itself
failed), `:205` (post-reset verification found HEAD wrong, tracked files mismatched, or residual git
state remaining), and `:128` (residual git operation state could not be cleared after a *successful*
apply). Three of these four build an error message containing the words *"repository NOT verified
restored ... Manual inspection required"* — the prose is honest; the exit code is not.

An agent branches on the code, not the prose. Told "verified restored, resolve and retry", it retries
`apply` — or worse, proceeds with its own work — against a working tree that may be mid-cherry-pick, at
the wrong HEAD, or carrying changes nobody has inspected.

Goal: the exit code alone distinguishes "the apply did not land and your repository is as you left it"
from "the apply did not land and your repository needs a human before anything else touches it".

## Root cause

There is exactly one exit code for a family of outcomes whose only safe reactions are opposites. The
rollback path in `apply.js` was written to *report* the difference in the message text, and the message
text is not a machine-readable discriminator — the same mistake design-spec §8 forbids for classification
("a bare number is not a discriminator") applied in reverse: here a rich fact was collapsed *into* a bare
number.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §7:

> Stable and append-only.

and, on the class table:

> Append-only contract: adding a class or a code is allowed, changing an existing value is not.

So: **add a code, do not redefine `25`.** `25` keeps meaning exactly what it means today for the two
restored cases. The unrestored cases move to a new code, and moving them is not a redefinition of `25` —
it is the removal of a use `25` never documented.

Also §8:

> | `apply_conflict` | Restore and report. Never auto-resolve. |

The new class's reaction is not "restore" — restoration is what already failed. It is "stop, and do not
touch the repository again until a human has".

## Files to read and trace first

- `core/commands/apply.js` — `_rollbackOrReport`, `_hardReset`, `_verifyRestored`, and the residual-state
  check at the end of the success path. All four unrestored throws are here. Note that `:128` is
  reached *after* the apply landed, which is a different story from the other three and may deserve its
  own answer.
- `core/worktree.js` — `cherryPickCommits`, `createApplyCommit`. The two legitimate `25`s.
- `core/failure-class.js` — `FAILURE_CLASS_TO_EXIT_CODE` and `exitCodeToFailureClass`. `apply_conflict`
  appears in §8's class table but is not in that mapping; establish how `25` currently reaches the
  process before adding a sibling, or the new code will be wired differently from the old one.
- `cli/dcli.js` — where a thrown `err.exitCode` becomes the process exit code, and what the `--json`
  envelope carries alongside it.
- `tests/` — whatever asserts `25` today. A test asserting `25` on a rollback-failure path is asserting
  the bug; it changes with this ticket, and the change must be deliberate.

Line numbers drift; the function names above are the spec.

## What to build

### 1. A new exit code for "repository state not verified"

Append one code and one named failure class for: the apply did not complete and the repository could not
be proven to be back at its pre-apply state. Record the chosen number and class name in Notes — both
enter the contract the moment they ship.

### 2. Route the four unrestored sites to it

`apply.js:150`, `:170`, `:205` throw the new code. `:128` (residual state after a landed apply) is a
judgement call: the apply *succeeded*, so it is not an apply conflict at all. Decide where it belongs and
say why in Notes — do not leave it on `25` by default just because it is out of scope.

`worktree.js:312` and `:342` keep `25`.

### 3. Make the distinction machine-readable, not just numeric

The `--json` envelope for a failed `apply` states whether the repository was verified restored. An agent
that already has the envelope should not have to infer it from the exit code, and a human reading the
text output should not have to infer it from the absence of a phrase.

### 4. Documentation in the same commit

- `docs/design-spec.md` §7: add the new code's row; leave `25`'s wording as the restored case only.
- `docs/design-spec.md` §8: add the new class with its reaction — never retry, never touch the
  repository again automatically, surface to the human.
- `integration/source/core.md`: add the row to the agent failure table. The `25` row's "Resolve and
  retry" becomes correct once the unrestored cases have left it.
- `README.md` and `docs/reference/*` wherever `25` is described.
- Regenerate with `node scripts/generate-integration.js`, re-run `install.ps1`, confirm the installed
  `SKILL.md` copies byte-match the repo.

## Non-goals

- **Making rollback more reliable.** This ticket reports the state honestly; it does not try to recover
  more cases. A better rollback is a separate ticket and does not remove the need for this code.
- **Changing `25`'s meaning, or any other existing code's.** Append-only.
- **A general exit-code reachability sweep.** Ticket 121 covers `10`/`1`; `26`'s reachability is
  unproven and belongs to neither ticket.
- **Touching `git reset --hard` behavior or the `--allow-untracked` decision.**

## Acceptance criteria

- [ ] **A.** A failed apply whose rollback was verified still exits `25`, proven by the existing
  cherry-pick-failure test, unmodified.
- [ ] **B.** A failed apply whose `git reset --hard` failed exits the new code, proven by a test that
  forces the reset to fail.
- [ ] **C.** A failed apply whose post-reset verification found the repository changed exits the new
  code, proven by a test.
- [ ] **D.** The `--json` envelope for both outcomes states whether the repository was verified restored,
  and the two differ.
- [ ] **E.** `exitCodeToFailureClass(<new code>)` returns the new class, and no adapter can produce it
  (invariant 2 — this is a wrapper-side condition only).
- [ ] **F.** No test still asserts `25` for an unrestored outcome.
- [ ] **Z.** `npm run check` green; tracker table regenerated via `node scripts/generate-tickets-table.js`;
  `README.md`, `docs/design-spec.md`, `docs/reference/*` and `integration/source/*` updated in the same
  commit, with installed skill copies verified byte-identical.

## Agent checks

```bash
# Every remaining exit-25 site is a restored-state site:
grep -rn "exitCode = 25" core/
# expect: only the cherryPickCommits / createApplyCommit sites in core/worktree.js

# No site claims restoration in the message while returning the restored code:
grep -rn "NOT verified restored" core/
# expect: every match sits with the new exit code, never 25

# The new code round-trips to a named class:
node -e "const f=require('./core/failure-class');console.log(f.exitCodeToFailureClass(<new code>))"
# expect: the new class name, not null

# Docs and installed skills agree:
node scripts/generate-integration.js --check
# expect: passes with no drift reported
```

## Notes

(Empty — the implementer fills this in.)
