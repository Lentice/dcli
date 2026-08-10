# Tickets

One ticket is one unit of work, written to be picked up cold. To implement one, read
[`00-onboarding.md`](00-onboarding.md) and your ticket file — nothing else, unless your ticket names it.
To write one, read [`../../AGENTS.md`](../../AGENTS.md) ("Writing a ticket") and
[`TEMPLATE.md`](TEMPLATE.md).

This table is the current state of work. **Closed tickets stay in it** — a closed ticket's Notes are the
record of what was determined, and 81's in particular carries the `/session/status` root cause and the
version-pin re-check.

## One place owns status

**A ticket's status and blockers live in its own file**, as a `**Status:** <value>` /
`**Blocked by:** <ids>` pair beneath the title. The two tables below are **generated** from those files
by [`scripts/generate-tickets-table.js`](../../scripts/generate-tickets-table.js) and are derived
output, not a second copy. The failure this structure exists to prevent was the sibling project's: it
accumulated twelve item files claiming work was still waiting while its tracker had them finished, and
an agent reading one of those files cold would have implemented it a second time. Here the files are
the tracker — edit a ticket, run `node scripts/generate-tickets-table.js`, and `npm run check` fails
naming the drifted ticket if the table was not regenerated.

Tickets 78–86 predate the rule and still carry a frozen `**Status:**` line in an older format; they are
closed and never edited, so the generator reads them as-is. A few closed tickets (87–91 and 105) carry
no status line at all, so their rows' status cells are kept from the table — their files cannot supply
one. New tickets follow [`TEMPLATE.md`](TEMPLATE.md), which requires the field.

**When this table becomes a chore, generate it.** The trigger was more than ten open tickets. It fired
on **2026-08-10**; [ticket 104](104-generate-the-ticket-tracker.md) built the generator and the
staleness check. The tables below are now produced from the ticket files, not maintained by hand.

| Status | Meaning |
|---|---|
| `ready` | Blockers are done; can be handed to an implementer |
| `in progress` | Being implemented now |
| `blocked` | A named ticket or external condition must land first |
| `done` | Acceptance criteria met, Notes filled in |
| `closed, not implemented` | Closed by decision, with nothing built |

## Open

Tickets 92–101 came out of the architecture review of 2026-08-10 (three independent reviewers; every
claim re-verified against the tree at `adcbac1` before the ticket was written). They are listed in
recommended order.

<!-- GENERATED: open ticket table -->
| Ticket | Status | Blocked by | Scope |
|---|---|---|---|
| [94 — `submit --mode` ignored](94-submit-mode-is-silently-ignored.md) | ready | — | `submit --mode implement` is validated, accepted, and silently run in `run` mode; honour it or reject with exit `2` |
| [96 — job-store owns scanning](96-job-store-owns-record-scanning.md) | ready | — | Four commands reach into `store._stateRoot`; three rebuild the jobs walk and disagree on what exit `17` means |
| [97 — one worker spawn path](97-one-worker-spawn-path.md) | ready | — | The initial submit and the queued relaunch spawn the worker separately, with different environments |
| [98 — split `commands/index.js`](98-split-the-commands-index-grab-bag.md) | blocked | 93 | Five unrelated subjects in one 576-line file that every module imports; also deletes the dead `KNOWN_FLAGS` export |
| [99 — codex/claude spawn seam](99-codex-claude-adapters-spawn-seam.md) | ready | — | `_testMode` short-circuits the methods that matter, so adapter coverage is nominal; inject the child process instead |
| [100 — opencode transport seam](100-opencode-adapter-transport-seam.md) | ready | — | Twenty-one `_testMode` branches, and tests that reach into private methods; supply a transport and an SSE source |
| [101 — reducer decides publishability](101-reducer-decides-publishability.md) | ready | — | `JobStore` re-derives half the reducer's decision by matching a `failure.reason` string literal |
| [102 — unix process-group containment](102-unix-process-group-containment.md) | ready | — | Rung 1 of ADR-010. Backends are spawned without `detached` and killed by pid, so descendants survive; on Unix this is a full guarantee costing one spawn option |
| [103 — windows degraded tree kill](103-windows-declared-degraded-tree-termination.md) | blocked | 102 | Rung 2 of ADR-010. Verified descendant enumeration + `taskkill /T /F`, `degraded: true`, survivors named and exit `21` — never a kill it did not confirm |
<!-- /GENERATED: ticket table -->

## Closed

<!-- GENERATED: closed ticket table -->
| Ticket | Status | Blocked by | Scope |
|---|---|---|---|
| [00 — onboarding](00-onboarding.md) | reference | — | Repository rules and current job model |
| [78 — containment wiring](78-adapters-spawn-through-containment.md) | **closed, not implemented** (2026-08-04) | — | Abandoned by decision: the native helper discards stdin, and codex/claude deliver the prompt there. Superseded 2026-08-10 by **ADR-010**, which replaces its all-or-nothing framing with a capability ladder — tickets 102 and 103 are rungs 1 and 2; this ticket was rung 3 and reopens only on evidence |
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
| [105 — the suite is not reliably green](105-full-suite-is-not-reliably-green.md) | **done** (2026-08-10) | — | Misleading `ETIMEDOUT`-as-crash diagnostics fixed, load-sensitive internal budgets derived from the runner's cap, near-cap runs reported; default concurrency kept — green on ten consecutive runs |
| [104 — generate this table](104-generate-the-ticket-tracker.md) | done | — | The tracker's own documented trigger fired at more than ten open tickets; ticket files become the source of status, with a regenerate-and-compare gate in `npm run check` |
| [93 — one failure-class table](93-one-failure-class-exit-code-table.md) | done | — | The class ↔ exit-code mapping exists three times (`commands/index.js`, `doctor.js`, `reducer.js`); one module owns both directions |
| [92 — one attempt driver](92-one-attempt-driver.md) | done | — | The detached worker and the foreground path stop being two copies of one algorithm; closes four verified behaviour divergences, including that `dcli cancel` does not reach a foreground `run` |
| [95 — one job-creation preamble](95-one-job-creation-preamble.md) | done | — | `run`/`resume`/`submit` write the same acquire-or-release-everything setup three times; `openAttempt()` owns it |
<!-- /GENERATED: ticket table -->

**A closed ticket is not necessarily an implemented one.** 81 was closed because it was fixed; 78 was
closed because it was abandoned, with nothing built. The distinction is in the Status column and in each
ticket's closing section — do not read "closed" as "the system does this now".

82, 83, 84 and 85 came out of dogfooding on 2026-08-04 while retiring a state root; 86 was filed from
81's Notes. Each ticket records what was observed.

Every change must update the canonical docs and pass `npm run check` in an environment that permits the
test suite's temporary directories.
