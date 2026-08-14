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
claim re-verified against the tree at `adcbac1` before the ticket was written).

Tickets 107–120 came out of the 2026-08-11 dual-backend audit (claude + codex agents, each tracing
the main user scenarios end to end; claims re-verified against the tree at `51e2d35` before each
ticket was written). Both audits are independent, so findings were merged by subject; overlapping
findings (the admission queue, the worker startup record) became single tickets.

Both groups are listed in recommended implementation order. The ordering rule: contract and
security fixes before robustness; reducer-touching tickets adjacent (113 before 107, so the
reducer is edited once per sitting); `core/commands/worker.js`-touching tickets adjacent (112
then 114); the pure-docs ticket last. No ticket is blocked by another.

<!-- GENERATED: open ticket table -->
| Ticket | Status | Blocked by | Scope |
|---|---|---|---|
| [125 — the runner's own byte-exact test compares a load-dependent section](125-test-runner-byte-exact-comparison-is-load-dependent.md) | in progress | — | Ticket 105's `--- LOAD ---` report varies with concurrency by design, and block 1's scrubber does not remove it, so `npm run check` fails at random under load |
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
| [89 — apply rollback verification](89-apply-rollback-verifies-restoration.md) | **done** (2026-08-09) | — | `apply` rollback fails closed: a failed `git reset --hard` must throw naming the non-restoration instead of returning as if the repo were restored. Shipped as exit `25`; **ticket 122 moved every unverified outcome to exit `27`**, so `25` now means verified-restored only |
| [87 — remove unused runtime imports](87-remove-unused-runtime-imports.md) | **done** (2026-08-09) | — | Remove verified unused import bindings from nine runtime modules without changing lint policy or contracts |
| [90 — setup resource cleanup](90-setup-failure-releases-resources.md) | **done** (2026-08-09) | — | A run/resume setup exception releases the worktree and admission slot it acquired before rethrowing |
| [91 — headless containment test](91-containment-test-headless-safe.md) | **done** (2026-08-09) | — | Keep containment coverage reliable and explicit without a desktop dependency |
| [105 — the suite is not reliably green](105-full-suite-is-not-reliably-green.md) | **done** (2026-08-10) | — | Misleading `ETIMEDOUT`-as-crash diagnostics fixed, load-sensitive internal budgets derived from the runner's cap, near-cap runs reported; default concurrency kept — green on ten consecutive runs |
| [104 — generate this table](104-generate-the-ticket-tracker.md) | done | — | The tracker's own documented trigger fired at more than ten open tickets; ticket files become the source of status, with a regenerate-and-compare gate in `npm run check` |
| [93 — one failure-class table](93-one-failure-class-exit-code-table.md) | done | — | The class ↔ exit-code mapping exists three times (`commands/index.js`, `doctor.js`, `reducer.js`); one module owns both directions |
| [92 — one attempt driver](92-one-attempt-driver.md) | done | — | The detached worker and the foreground path stop being two copies of one algorithm; closes four verified behaviour divergences, including that `dcli cancel` does not reach a foreground `run` |
| [95 — one job-creation preamble](95-one-job-creation-preamble.md) | done | — | `run`/`resume`/`submit` write the same acquire-or-release-everything setup three times; `openAttempt()` owns it |
| [97 — one worker spawn path](97-one-worker-spawn-path.md) | done | — | The initial submit and the queued relaunch spawn the worker separately, with different environments |
| [94 — `submit --mode` ignored](94-submit-mode-is-silently-ignored.md) | done | — | `submit --mode implement` is validated, accepted, and silently run in `run` mode; honour it or reject with exit `2` |
| [96 — job-store owns scanning](96-job-store-owns-record-scanning.md) | done | — | Four commands reach into `store._stateRoot`; three rebuild the jobs walk and disagree on what exit `17` means |
| [101 — reducer decides publishability](101-reducer-decides-publishability.md) | done | — | `JobStore` re-derives half the reducer's decision by matching a `failure.reason` string literal |
| [98 — split `commands/index.js`](98-split-the-commands-index-grab-bag.md) | done | — | Five unrelated subjects in one 576-line file that every module imports; also deletes the dead `KNOWN_FLAGS` export |
| [106 — worker-liveness §6g is flaky: corrupt-projection regeneration depends on file mtime ticks](106-liveness-6g-corrupt-projection-flake.md) | done | — | The `status.json`-corruption check in liveness §6g only passes when the corrupt write shares an mtime tick with the journal — measured coin flip |
| [99 — codex/claude spawn seam](99-codex-claude-adapters-spawn-seam.md) | done | — | `_testMode` short-circuits the methods that matter, so adapter coverage is nominal; inject the child process instead |
| [100 — opencode transport seam](100-opencode-adapter-transport-seam.md) | done | — | Twenty-one `_testMode` branches, and tests that reach into private methods; supply a transport and an SSE source |
| [102 — unix process-group containment](102-unix-process-group-containment.md) | done | — | Rung 1 of ADR-010. Backends are spawned without `detached` and killed by pid, so descendants survive; on Unix this is a full guarantee costing one spawn option |
| [103 — windows degraded tree kill](103-windows-declared-degraded-tree-termination.md) | done | — | Rung 2 of ADR-010. Verified descendant enumeration + `taskkill /T /F`, `degraded: true`, survivors named and exit `21` — never a kill it did not confirm |
| [111 — wait --all reports corruption as a timeout](111-wait-all-corrupt-state-exit.md) | done | — | Final post-deadline list read returns exit 20 for corrupt state; must return 17 like the polling loop |
| [113 — scrub-session-ids must survive replay](113-scrub-session-ids-must-survive-replay.md) | done | — | The scrub rewrites only the projection; a journal event must make it durable |
| [107 — the admission queue strands and relaunches](107-admission-queue-lifecycle.md) | done | — | Queued jobs can wait forever (dequeue only on slot release) and cancelled queued jobs still launch |
| [112 — worker startup failure record](112-worker-startup-failure-record.md) | done | — | Startup failures write a string into the structured `failure` field and skip the completion sentinel |
| [114 — the detached worker lacks the redactor](114-worker-initializes-the-redactor.md) | done | — | The worker process never initializes the writer-path redactor; registration is a silent no-op |
| [108 — `--access full` is out of contract](108-access-full-is-out-of-contract.md) | done | — | Accepted, undocumented, and three different postures per backend (opencode grants external access; codex/claude silently downgrade) |
| [119 — capacity misreported as quota](119-admission-capacity-is-lock-class.md) | done | — | At-capacity fails exit 14/quota ("never retry") though it is a transient local condition; the `lock` class/17 exists |
| [115 — read exits 0 with no result](115-read-exits-11-without-result.md) | done | — | Terminal job without `result.md` returns success; must be exit 11 |
| [120 — cancelled job loses its snapshot](120-cancelled-job-keeps-snapshot.md) | done | — | `finishCancelled` is the only terminal exit that skips `finalizeWorktreeSnapshot()` |
| [109 — deadlines: one source of truth](109-deadlines-one-source-of-truth.md) | done | — | Six §13 boundaries have no production consumer; drain ships 3000 ms against a documented 5000 ms; HTTP is one 10 s bound against a 10 s/60 s contract |
| [110 — submit leaks on spawn failure](110-submit-leaks-on-spawn-failure.md) | done | — | A failed worker launch leaves a `created` job and a registered worktree |
| [116 — codex/claude streams unbounded](116-bounded-stream-retention.md) | done | — | The two collectors retain stdout/stderr with no cap; opencode already caps |
| [117 — probes use shell strings](117-probes-use-argument-arrays.md) | done | — | Version/doctor probes interpolate executable paths into `execSync` strings, bypassing the quoting seam |
| [118 — docs drift](118-docs-drift-modes-recursion-containment.md) | done | — | §16 mode vocabulary, the claude recursion-guard paragraph, and §14 containment-record timing contradict the code |
| [121 — a failed backend run exits 1, but every document says it exits 10](121-exit-10-is-documented-but-unreachable.md) | done | — |  |
| [122 — exit 25 promises the repository was restored, and is also returned when it provably was not](122-exit-25-claims-the-repository-was-restored-when-it-was-not.md) | done | — |  |
| [123 — remove the opencode automation-policy dead path, and the error that sends callers after a flag that does not exist](123-remove-the-opencode-automation-policy-dead-path.md) | done | — |  |
| [124 — the interaction responder seam has no product caller, and three of its four outcomes cannot be produced](124-the-interaction-responder-seam-has-no-caller.md) | done | — |  |
<!-- /GENERATED: ticket table -->

**A closed ticket is not necessarily an implemented one.** 81 was closed because it was fixed; 78 was
closed because it was abandoned, with nothing built. The distinction is in the Status column and in each
ticket's closing section — do not read "closed" as "the system does this now".

82, 83, 84 and 85 came out of dogfooding on 2026-08-04 while retiring a state root; 86 was filed from
81's Notes. Each ticket records what was observed.

Every change must update the canonical docs and pass `npm run check` in an environment that permits the
test suite's temporary directories.
