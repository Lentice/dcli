# Tickets

Tracer-bullet vertical slices for `dcli`, numbered in dependency order (blockers first). Each ticket is a
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
| [28](28-parallel-test-runner.md) | Parallel test runner | — | Tooling |
| [29](29-submit-dispatches-real-worker.md) | `submit` actually launches a background worker | — | Stability review |
| [30](30-cancel-cli-dispatch.md) | Wire `cancel` into the CLI dispatcher | 29 | Stability review |
| [31](31-adapter-dispose-lifecycle.md) | Call `adapter.Dispose()` on every terminal path | — | Stability review |
| [32](32-codex-collect-result-facts.md) | codex `CollectResult` must use its own parsed facts | — | Stability review |
| [33](33-opencode-cancel-rung-escalation.md) | opencode cancellation must escalate through every rung | — | Stability review |
| [34](34-resume-prompt-positional-fix.md) | `resume` must not let the job ID leak into the prompt | — | Stability review |
| [35](35-bounded-stream-drain-before-parse.md) | codex/claude must drain streams before parsing results | — | Stability review |
| [36](36-admission-control-atomicity.md) | Admission control must be atomic; dequeue must launch | 29 | Stability review |
| [37](37-installer-stage-swap-full-ownership.md) | Installer must stage-and-swap the full owned tree | — | Stability review |
| [38](38-generate-integration-check-real-diff.md) | `generate-integration --check` must really diff output | — | Stability review |
| [39](39-windows-argv-quoting-correctness.md) | Correct Win32 argv serialization, shared by both paths | — | Stability review |
| [40](40-fix-broken-background-recipe-in-templates.md) | Fix the broken background-task recipe in templates | 38 | Stability review |
| [41](41-install-does-not-put-clis-on-path.md) | Install must put shims on PATH | — | Stability review |
| [42](42-result-bytes-not-persisted.md) | Real results not persisted or counted | — | Stability review |
| [43](43-opencode-submit-canonicaldir.md) | opencode submit fails — missing canonicalDir | — | Stability review |
| [44](44-attempt-directories-always-empty.md) | Attempt directories always empty | 42 | Stability review |
| [45](45-cli-ignores-dcli-state-root-when-repo-given.md) | `DCLI_STATE_ROOT` ignored when `--repo` is given | — | Stability review |
| [46](46-worker-hard-timeout-inert.md) | Worker hard timeout is inert and never kills the tree | — | Code review |
| [47](47-reducer-bypassed-on-submit-path.md) | Reducer/reconciliation bypassed on the submit path | — | Code review |
| [48](48-worker-ignores-cancel-request.md) | Worker ignores `cancel.request`; cancel races the projection | 47 | Code review |
| [49](49-queued-jobs-never-relaunched.md) | Queued jobs are never re-launched by `tryDequeue` | — | Code review |
| [50](50-default-state-root-is-test.md) | Production default state root is `<platform-root>/test` | — | Code review |
| [51](51-admission-reused-pid-counted-as-live.md) | Admission liveness counts reused PIDs as live slots | — | Code review |
| [52](52-opencode-cmd-shim-einval.md) | opencode server spawn bypasses cmd.exe wrapping (EINVAL on .cmd) | — | Code review |
| [53](53-backend-conditional-in-core.md) | Backend-specific conditionals in core/ (registry refactor) | — | Code review |
| [54](54-no-default-hard-timeout-run-review-resume.md) | run/review/resume have no default hard timeout; worker does | — | Code review |
| [55](55-observe-end-hardcoded-failed.md) | Observe-end terminal transition hardcoded failed/exit 1, bypassing reducer | — | Code review |
| [56](56-resume-drops-followup-prompt.md) | resume drops the follow-up prompt (positionals slice bug) | — | Code review |
| [57](57-recover-always-done.md) | Recover() always returns done; no durable evidence check | — | Code review |
| [58](58-opencode-reject-interaction-rethrow.md) | opencode reject-interaction rethrows instead of yielding fact | — | Code review |
| [59](59-opencode-cancel-unawaited.md) | opencode cancel rungs unawaited; null serverBaseUrl | — | Code review |
| [60](60-native-helper-stdin-and-eof-drain.md) | Native helper lacks stdin forwarding and bounded EOF drain | — | Code review |
| [61](61-collect-diagnostics-exit-code-always-0.md) | CollectDiagnostics always returns exit_code 0 | — | Code review |
| [62](62-codex-unbounded-result-missing-clean.md) | codex CollectResult unbounded read + missing-result classified as clean | — | Code review |
| [63](63-opencode-malformed-metadata-success.md) | opencode unknown sentinel falls through to success default | — | Code review |
| [64](64-observe-non-temporal-fact-order.md) | Observe generator assumes non-temporal fact ordering | — | Code review |
| [65](65-codex-temp-dir-leak.md) | codex temp directory not cleaned up on cleanup/teardown | — | Code review |
| [66](66-trydisposeadapter-unbounded.md) | tryDisposeAdapter is synchronous and unbounded | — | Code review |
| [67](67-admission-locking-pid-identity.md) | Admission liveness assumes PID is current owner | — | Code review |
| [68](68-locking-robustness.md) | Locking robustness: corrupt/missing/cpu-spin | — | Code review |
| [69](69-worker-hard-timeout-no-tree-kill.md) | Worker hard-timeout does not kill the process tree | — | Code review |
| [70](70-apply-cleanup-destructive.md) | apply/cleanup can destroy non-owned untracked files | — | Code review |
| [71](71-cancel-overwrites-done.md) | Cancel can overwrite a done job | — | Code review |
| [72](72-review-unbounded-slice-spawnsync.md) | Review: four bugs (unbounded read, byte-slice, maxBuffer, spawnSync timeout) | — | Code review |
| [73](73-test-state-root-and-backend-validation.md) | Test state root gate and --backend enum validation | — | Code review |
| [74](74-installer-worker-prompts-and-staging.md) | Installer: atomic staging + worker prompt isolation | — | Code review |
| [75](75-docs-mode-promptfile-scrub-drift.md) | Docs drift: --mode, --prompt-file, scrub-session-ids in skills | — | Code review |
| [76](76-dcli-claude-silent-failure-read-only.md) | dcli-claude run silently fails tasks needing Task/subagent tool | — | Code review |
| [77](77-load-flaky-test-time-budgets.md) | Suite dominated by ~200ms process-spawn cost; time budgets fail unpredictably | — | Tooling |

Tickets **14 and 15 are built in parallel** — they are two halves of one proof.

Tickets **29–40** came out of a 2026-07-29 stability/performance review (Codex-assisted, independently
verified — several confirmed live against real `codex`/`opencode` invocations) of the shipped
implementation, run after ticket 28. Tickets **41–45** were added in the same session by a
live functional test against real backends (opencode, codex, claude). They are not ordered vertical
slices in the tracer-bullet sense — each is an independent bug-fix scoped to one root cause, safe to
pick up in any order except where a blocking edge is listed.

Tickets **46–51** came out of a 2026-07-30 source-code review against the standing rules in `AGENTS.md`
and the development guide (no live run required — the defects are visible in the shipped code, and the
full suite is green while they exist). Again each is an independent bug-fix scoped to one root cause;
the only blocking edge is 48 on 47, because the worker self-cancel in 48 is only authoritative once the
reducer projection of 47 makes terminal decisions stick. 49 and 51 are the unfinished halves of ticket
36 — atomicity and slot-owner metadata landed in commit `8bd5995`, but "dequeue must launch" and
PID-reuse liveness did not, so they are recorded here rather than left as silent gaps in 36.

Tickets **52–76** came out of a 2026-07-30 comprehensive four-parallel-subagent review of the entire
codebase (core/, adapters/, cli+native+installer, docs+integration) against `AGENTS.md` invariants and the
nine-mistake catalog, plus a live repro of the dcli-claude silent failure (ticket 76 — done). The 25
tickets are ordered from easiest to most complex, with the final seven (70–76) requiring either
cross-cutting state-machine work or Win32 container integration. Three blocking edges exist:
55 (observe-end reducer routing) is a prerequisite for 71 (cancel-vs-done race), and 67 (admission PID
identity) unblocks the locking work in 68. Ticket 76 (failure_reason observable + access hint) is
closed — the remaining 24 are ready-for-agent.

## Complexity tiers for agent assignment

| Tier | Tickets | Description |
|---|---|---|
| Low | 52, 54, 56, 61, 65, 75 | Mechanical fixes — single file, existing helper reuse |
| Medium | 58, 59, 62, 63, 64, 67, 70, 72, 73, 76 | Single subsystem, moderate reasoning |
| High | 53, 55, 57, 60, 66, 68, 69, 71, 74 | Cross-cutting, state-machine, or Win32-deep — assign to higher-level agent |

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
| 27 | A native Claude child escapes containment, or recursion cannot be bounded | Record as an ADR-001 R6 finding; isolate or abandon `dcli-claude` rather than weakening all backends |
