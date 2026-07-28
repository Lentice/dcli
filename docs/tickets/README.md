# Tickets

Tracer-bullet vertical slices for `delegate-cli`, numbered in dependency order (blockers first). Each ticket is a
**self-contained design spec with a checklist** — read [`00-onboarding.md`](00-onboarding.md) plus your one ticket
file and you have everything you need.

Written to the `/to-tickets` local-file shape, but committed under `docs/tickets/` rather than a scratch directory
so the breakdown survives as part of the project handoff.

**Work the frontier**: any ticket whose blockers are all done. Clear context between tickets.

## Order

| # | Ticket | Blocked by | Group |
|---|---|---|---|
| [00](00-onboarding.md) | Onboarding — read once before any ticket | — | — |
| [01](01-repo-skeleton-and-test-harness.md) | Repo skeleton, atomic UTF-8 writers, test runner | — | Foundation |
| [02](02-adapter-contract-and-fake-adapter.md) | Fact-based adapter contract + fake adapter | 01 | Foundation |
| [03](03-state-root-jobs-journal.md) | State root, job/attempt dirs, journal + status projection | 01, 02 | Foundation |
| [04](04-lifecycle-reducer-and-reconciliation.md) | Lifecycle reducer, reconciliation, `interrupted` | 02, 03 | Foundation |
| [05](05-locking-process-identity-token.md) | Locking, process identity, execution token | 03 | Foundation |
| [06](06-process-containment-and-bun-experiment.md) | Containment + the Job-Object-on-Bun experiment | 05 | Foundation |
| [07](07-deadlines-and-pipe-draining.md) | Deadlines and concurrent pipe draining | 02, 06 | Foundation |
| [08](08-cancellation-declared-rungs.md) | Cancellation with adapter-declared rungs | 06, 07 | Foundation |
| [09](09-fault-injection-harness.md) | Fault-injection harness | 04, 06, 08 | Foundation |
| [10](10-core-commands.md) | Core commands: run, submit, status, wait, read, list | 04, 07 | Foundation |
| [11](11-tail-debug-cleanup.md) | tail, debug, cleanup, retention | 10 | Foundation |
| [12](12-capabilities-doctor-option-validation.md) | capabilities, doctor framework, option validation | 02, 10 | Foundation |
| [13](13-redaction-and-admission-control.md) | Secrets redaction and admission control | 03, 10 | Foundation |
| [14](14-thin-opencode-slice.md) | Thin opencode adapter slice | 02, 10 | Boundary proof |
| [15](15-thin-codex-slice.md) | Thin codex adapter slice | 02, 10 | Boundary proof |
| [16](16-contract-parity-gate.md) | Contract parity gate across both slices | 14, 15 | Boundary proof |
| [17](17-opencode-server-lifecycle.md) | opencode: per-job server lifecycle | 16 | opencode |
| [18](18-opencode-session-permissions-routing.md) | opencode: session, permission ruleset, directory routing | 17 | opencode |
| [19](19-opencode-async-prompt-and-reconciliation.md) | opencode: prompt_async, event stream, reconciliation | 18 | opencode |
| [20](20-opencode-interactions-and-classification.md) | opencode: interactions, blocked, classification, doctor | 19 | opencode |
| [21](21-review-and-findings.md) | Scoped review with embedded diff and findings contract | 20 | Shared |
| [22](22-worktree-implement-diff-apply.md) | Worktree isolation: implement, diff, apply | 21 | Shared |
| [23](23-resume-and-lineage.md) | resume: three kinds plus lineage | 22 | Shared |
| [24](24-generated-integration-and-installer.md) | Generated Claude integration and installer | 23 | Shared |
| [25](25-codex-adapter-full.md) | codex adapter in full | 24 | codex |
| [26](26-claude-adapter.md) | claude adapter | 25 | claude |
| [27](27-claude-recursion-guards.md) | claude recursion guards, doctor, capabilities | 26 | claude |

Tickets **14 and 15 are built in parallel** — they are two halves of one proof.

## Why the order is what it is

Backend order is **opencode → codex → claude**, as required. Foundation and shared modules come first.

Tickets 14–16 exist because the [architecture review](../2026-07-28-architecture-review-record.md) established
that building the engine against opencode alone would over-fit the adapter contract to HTTP sessions — after which
Codex and Claude would need fake sessions, or the engine would grow a parallel synchronous path. So a **thin**
Codex slice proves the boundary early (ticket 15) while the **full** Codex adapter still comes after opencode
(ticket 25).

Ticket 16 is a **gate**. If it fails, the deliverable is a written analysis and a proposed contract change — not a
workaround.

Ticket 06 contains the **one experiment that can reverse the language decision**: if a Windows Job Object cannot be
attached to the Bun-built opencode binary before it spawns descendants, the answer is pure Go, and that must be
discovered before any adapter work.

## Three tickets carry stop-and-escalate conditions

| Ticket | Condition | Response |
|---|---|---|
| 06 | Job Object cannot contain the Bun binary | Reverse ADR-003 to pure Go; re-scope |
| 16 | Contract needs a backend-specific skip, or `core/` needs a conditional | Change the contract; if impossible, invoke the ADR-001 kill criteria |
| 27 | A native Claude child escapes containment, or recursion cannot be bounded | Record as an ADR-001 R6 finding; isolate or abandon `cclaude` rather than weakening all backends |
