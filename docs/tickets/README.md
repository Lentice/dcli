# Tickets

One ticket is one unit of work, written to be picked up cold. To implement one, read
[`00-onboarding.md`](00-onboarding.md) and your ticket file — nothing else, unless your ticket names it.
To write one, read [`../../AGENTS.md`](../../AGENTS.md) ("Writing a ticket") and
[`TEMPLATE.md`](TEMPLATE.md).

This table is the current state of work. **Closed tickets stay in it** — a closed ticket's Notes are the
record of what was determined, and 81's in particular carries the `/session/status` root cause and the
version-pin re-check.

## One place owns status

**The table below is the only place a ticket's status and blockers are maintained.** A new ticket does
not repeat them in its own file, because two copies of the same fact drift and nothing here would catch
it: the sibling project maintaining this same structure accumulated twelve item files claiming work was
still waiting while the tracker had them finished, and an agent reading one of those files cold would
have implemented it a second time.

Tickets 78–86 predate this rule and still carry a `**Status:**` line. Theirs are accurate and frozen —
all are closed — so they are left as written, per "never edit a closed ticket". New tickets follow
`TEMPLATE.md`, which has no status field.

**When this table becomes a chore, generate it.** The trigger is more than ten open tickets, or the
first time the table and a ticket file disagree. At that point the ticket files become the source of
truth and this table is produced from them, with a staleness check in `npm run check` — the same shape
as the generated-skills gate in `AGENTS.md`. Do not build that machinery before the trigger.

| Status | Meaning |
|---|---|
| `ready` | Blockers are done; can be handed to an implementer |
| `in progress` | Being implemented now |
| `blocked` | A named ticket or external condition must land first |
| `done` | Acceptance criteria met, Notes filled in |
| `closed, not implemented` | Closed by decision, with nothing built |

## Open

| Ticket | Status | Blocked by | Scope |
|---|---|---|---|

## Closed

| Ticket | Status | Blocked by | Scope |
|---|---|---|---|
| [00 — onboarding](00-onboarding.md) | reference | — | Repository rules and current job model |
| [78 — containment wiring](78-adapters-spawn-through-containment.md) | **closed, not implemented** (2026-08-04) | — | Abandoned by decision. Backend trees are never contained, so termination stays adapter-cooperative — read the ticket's closing section before trusting any termination guarantee |
| [81 — opencode unknown status](81-opencode-unknown-status-never-terminates.md) | **done** (2026-08-04) | — | Bound `unknown` status polling and preserve an honest terminal result |
| [82 — cleanup orphans worktrees](82-cleanup-orphans-worktrees.md) | **done** (2026-08-04) | — | Retention removes worktrees and git registrations, and reports existing orphans |
| [83 — `--older-than` hours](83-older-than-hours-is-unusable.md) | **done** (2026-08-04) | — | Retention accepts positive day and hour values consistently across parser, cleanup, and docs |
| [84 — launch identity](84-launch-identity-never-persisted.md) | **done** (2026-08-04) | — | Persist launch identity before worker startup so cancel and reconciliation can prove ownership |
| [85 — identityless records](85-identityless-records-never-terminate.md) | **done** (2026-08-04) | 82, 84 | Resolve records that can never prove a worker, bounded by the job's own deadline |
| [86 — doctor never launches a backend](86-doctor-never-launches-a-backend.md) | **done** (2026-08-04) | — | The live smoke is off by default, so `doctor` certifies a backend it never exercised |
| [88 — unused test imports](88-remove-unused-test-imports.md) | **done** (2026-08-09) | — | Remove the verified unused import bindings from fourteen test/helper files without changing behavior |
| [89 — apply rollback verification](89-apply-rollback-verifies-restoration.md) | **done** (2026-08-09) | — | `apply` rollback fails closed: a failed `git reset --hard` must throw exit `25` naming the non-restoration instead of returning as if the repo were restored |
| [87 — remove unused runtime imports](87-remove-unused-runtime-imports.md) | **done** (2026-08-09) | — | Remove verified unused import bindings from nine runtime modules without changing lint policy or contracts |
| [90 — setup resource cleanup](90-setup-failure-releases-resources.md) | **done** (2026-08-09) | — | A run/resume setup exception releases the worktree and admission slot it acquired before rethrowing |
| [91 — headless containment test](91-containment-test-headless-safe.md) | **done** (2026-08-09) | — | Keep containment coverage reliable and explicit without a desktop dependency |

**A closed ticket is not necessarily an implemented one.** 81 was closed because it was fixed; 78 was
closed because it was abandoned, with nothing built. The distinction is in the Status column and in each
ticket's closing section — do not read "closed" as "the system does this now".

82, 83, 84 and 85 came out of dogfooding on 2026-08-04 while retiring a state root; 86 was filed from
81's Notes. Each ticket records what was observed.

Every change must update the canonical docs and pass `npm run check` in an environment that permits the
test suite's temporary directories.
