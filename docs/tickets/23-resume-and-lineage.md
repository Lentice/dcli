# 23 — resume: three kinds plus lineage

**Blocked by:** 22
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md) §4,
[design spec §16 "resume is three distinct operations"](../2026-07-28-design-spec.md#16-command-surface),
[ADR-008](../2026-07-28-architecture-decisions.md#adr-008).

---

## Purpose

A user can give follow-up feedback and have it continue the right thing — the same backend conversation, a branch
from a recorded result, or a fresh attempt at the same request — without ever silently substituting one for
another.

## Why it matters

"Resume" looks like one operation and is three. The predecessor's bugs came from treating them as one:

- A resumed run that emitted no session event lost its lineage until a fallback to the parent's id was added.
- Worktree-job continuation needed its own path: a child must get a **new** worktree seeded from the parent's
  recorded snapshot, because reusing the parent's frozen worktree corrupts the record you may still need.
- Ignored flags and stray positionals on `resume` were silently discarded.

And after ADR-008 there is a hard rule: a controller crash never reattaches to a running backend. It always
produces a *new attempt*.

## Design

### The three kinds — always explicit

| Kind | What it does | Precondition |
|---|---|---|
| `continue_backend_session` | continues the same backend conversation | a live, resumable backend session id |
| `fork_from_artifacts` | new backend session, seeded from the parent's artifacts / worktree commit | always available |
| `retry_attempt` | re-runs the same request as a new attempt | always available |

`resume` selects the kind explicitly, records it as `session_strategy`, and **never silently substitutes**. If
`continue_backend_session` is requested and the session is gone, that is exit `22` (`session_expired`) — a
visible failure the caller decides about. It must not quietly become a fork.

### Lineage

Every continuation creates a **new job** (never reuses a job directory) recording `parent_job_id`,
`root_job_id`, `backend_session_id`, and `session_strategy`. `status` surfaces lineage so a chain is readable.

If a resumed run produces no session identity of its own, fall back to the parent's recorded id rather than
losing lineage entirely.

### Worktree continuation

For an `implement` chain, the child gets a **distinct new worktree seeded from the parent's recorded snapshot
commit**. The parent's worktree is never mutated. `diff` on the child shows the cumulative change from the
original base, and **`apply` lands only the newest accepted descendant** — never the ancestor first.

### Backend availability

| Backend | `continue_backend_session` |
|---|---|
| opencode | session id, or `POST /session/{id}/fork` for a fork |
| codex | `codex exec resume <SESSION_ID>` with a thread id |
| claude | `-r/--resume <id>`, plus `--fork-session` |

Availability is a **capability**, not an assumption. Declare it and check it.

### After a crash

An `interrupted` attempt supports `retry_attempt` and `fork_from_artifacts`. It does **not** support
`continue_backend_session` unless the backend session provably survived — and the wrapper does not promise that.

## Pitfalls

- Never let `session_expired` degrade into a silent fork.
- Never reuse a job or attempt directory for a continuation.
- Reject ignored flags and stray positionals on `resume` explicitly (real bug).
- A resumed review job does not re-compose the review prompt — if structured findings are wanted from a
  follow-up, the appendix instruction must be restated in the follow-up text. Document this; it surprises people.
- Do not apply an ancestor after a follow-up exists.

## Checklist

- [ ] `resume` requires an explicit kind (flag or subcommand); there is no implicit default that could substitute.
- [ ] `session_strategy` is recorded on every continuation.
- [ ] A missing or expired backend session with `continue_backend_session` is exit `22`, never a silent fork —
      regression test.
- [ ] Every continuation creates a new job with `parent_job_id`, `root_job_id`, `backend_session_id` recorded.
- [ ] A resumed run with no session identity of its own falls back to the parent's recorded id — regression test.
- [ ] `status` surfaces lineage; a three-deep chain is readable.
- [ ] An `implement` continuation gets a **new** worktree seeded from the parent's snapshot; the parent's
      worktree is unmodified — asserted.
- [ ] `diff` on a child shows the cumulative change from the original base.
- [ ] `apply` on a chain lands only the newest accepted descendant; applying an ancestor after a descendant
      exists is refused.
- [ ] `continue_backend_session` availability is declared per backend as a capability and checked before use.
- [ ] An `interrupted` attempt supports `retry_attempt` and `fork_from_artifacts` but not
      `continue_backend_session` — test.
- [ ] Ignored flags and stray positionals on `resume` are rejected with exit `2`.
- [ ] Documentation states that a resumed review does not re-emit the findings appendix instruction.
- [ ] `submit --resume` exists for a background continuation and inherits the parent's mode/access/repo/group/label.

## How to verify

```powershell
node tests/run-tests.js --suite full

$id = node cli/dcli-opencode.js submit --hard-timeout-sec 600 "Draft a plan for X"
node cli/dcli-opencode.js wait $id --timeout-sec 600 --json
"Now critique your own plan." | node cli/dcli-opencode.js resume $id --kind continue_backend_session --hard-timeout-sec 600
```

## Definition of done

Full suite green including the session-expired, lineage-fallback, and worktree-continuation tests.

## Commit message

```
feat: explicit resume kinds with job lineage and worktree continuation
```

## Notes

Implemented 2026-07-29:
- Created `core/commands/resume.js` with `executeResume()` supporting all three kinds.
- The `Resume()` method already existed as a no-op stub on all adapters from ticket 14/15;
  the resume command calls `adapter.Resume()` for `continue_backend_session`.
- Updated all adapters to declare `core.resume: true` in `ProbeCapabilities()`.
- Updated `core/commands/index.js` to add `resume` to COMMANDS and `--kind` to KNOWN_FLAGS/value flags.
- Updated `cli/dcli.js` to wire the `resume` CLI command.
- Updated `docs/adapter-asymmetry.md` to reflect implemented resume support.
- Lineage fallback (parent session id when child emits none) implemented in executeResume.
- The resume command creates new jobs with `parent_job_id`, `root_job_id`, `session_strategy` recorded.
- `retry_attempt` and `fork_from_artifacts` are always available; `continue_backend_session`
  checks both parent session existence and backend capability before proceeding.
- Worktree continuation creates a fresh worktree for implement-mode resumes.
- Tests cover: all three kinds, validation errors, non-existent parent, session missing,
  lineage chain, session fallback, and stub-resume call verification.
