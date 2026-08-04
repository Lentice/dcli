# Active tickets

The implementation work is complete except for the open tickets below. Historical implementation tickets were
removed from this directory; the binding contracts live in the design spec, adapter contract, and tests.

| Ticket | Status | Blocked by | Scope |
|---|---|---|---|
| [00 — onboarding](00-onboarding.md) | reference | — | Repository rules and current job model |
| [78 — containment wiring](78-adapters-spawn-through-containment.md) | **closed, not implemented** (2026-08-04) | — | Abandoned by decision. Backend trees are never contained, so termination stays adapter-cooperative — read the ticket's closing section before trusting any termination guarantee |
| [81 — opencode unknown status](81-opencode-unknown-status-never-terminates.md) | **done** (2026-08-04) | — | Bound `unknown` status polling and preserve an honest terminal result |
| [82 — cleanup orphans worktrees](82-cleanup-orphans-worktrees.md) | **done** (2026-08-04) | — | Retention removes worktrees and git registrations, and reports existing orphans |
| [83 — `--older-than` hours](83-older-than-hours-is-unusable.md) | open | — | The hour unit is accepted by the parser and always refused by the command |
| [84 — launch identity](84-launch-identity-never-persisted.md) | open | — | Nothing writes `worker_pid`/`worker_identity`, so `cancel` kills nothing and no death is provable |
| [85 — identityless records](85-identityless-records-never-terminate.md) | open | 82, 84 | Resolve records that can never prove a worker, bounded by the job's own deadline |
| [86 — doctor never launches a backend](86-doctor-never-launches-a-backend.md) | open | — | The live smoke is off by default, so `doctor` certifies a backend it never exercised |

82, 83, 84 and 86 are each independent. 84 is the widest — `cancel` currently reports without effect — and 85 is only meaningful once
84 has landed. Every change must update the canonical docs and pass `npm run check` in an environment that
permits the test suite's temporary directories.

**A closed ticket is not necessarily an implemented one.** 81 was closed because it was fixed; 78 was closed
because it was abandoned, with nothing built. The distinction is in the Status column and in each ticket's
closing section — do not read "closed" as "the system does this now".

**Closed tickets stay in this table with their outcome.** A closed ticket's Notes are the record of what was
determined, and 81's in particular carries the `/session/status` root cause and the version-pin re-check.

82, 83, 84 and 85 came out of dogfooding on 2026-08-04 while retiring a state root; 86 was filed from 81's
Notes. Each ticket records what was observed.
