# Architecture review record

Date: 2026-07-28. The design in [ADRs](architecture-decisions.md) and
[design spec](design-spec.md) was submitted for adversarial review to **two independent
reviewers**: the Codex CLI (`ccodex` job `20260728T090002Z-dti8uldm`) and the **opencode CLI itself**
(the backend the design is built around). Both were given the same brief and told to attack, not
endorse.

Every finding below is triaged explicitly: **ADOPTED** (with what changed) or **REJECTED** (with why).
Nothing was accepted on authority.

---

## Where the two reviewers independently agreed

Both named the same top risk, and both prescribed substantially the same fix. That agreement is the
strongest signal in this record.

> **Building the shared engine and the opencode adapter together will over-fit the adapter contract
> to HTTP sessions.** The interface would come to assume server readiness, SSE reconciliation,
> permission queues, HTTP abort, and "terminal session state" — while Codex and Claude Code are
> supervised CLI processes with stream protocols and a completely different notion of completion.
> The result: either fake sessions in the CLI adapters, or a parallel sync path in the engine that
> violates the no-backend-conditionals invariant.

opencode additionally demolished the argument I had used to justify the ordering:

> "'ccodex works today, porting risks regression' does **not** protect against over-fitting, because
> `dcli` is a separate repo. The Codex adapter in `dcli` does not touch the
> production `ccodex` tool. **No regression risk.**"

That is correct, and it was the load-bearing premise of my phase order. **ADOPTED** — see
ADR-007 and the revised build order.

---

## ADOPTED — architecture-changing

### 1. The adapter contract is fact-based, with an engine-owned terminal-state reducer
*(both reviewers; the deep fix for the over-fitting problem)*

The interface must not traffic in session events. Adapters emit **normalized facts**; the engine owns
a reducer that decides terminal state from those facts. Process exit, API session state, and parsed
output are all *evidence*, not verdicts.

`observe()` emits facts, not session events. `respond(interactionId, decision)` is optional by
capability. `requestCancel()`, `dispose()`, and `recover()` get explicit postconditions.
→ **New ADR-007.**

### 2. Cancellation rungs are declared by the adapter, not hardcoded by the engine
*(opencode)*

The four-rung ladder is a lie on two of three backends. Codex has no session abort and no dispose —
its ladder is exactly one rung, hard kill. opencode's is abort → wait → kill. Claude's, with native
agents bypassed, is also effectively one rung.

An engine with a hardcoded sequence is itself a violation of the no-backend-conditionals invariant.
Adapters now **declare their rungs**; the engine walks whatever they declare and records which rung
was reached. → **ADR-007**, spec §14.

### 3. Interaction *outcome* is unified even though interaction *mechanics* are not
*(Codex — a place I over-separated)*

I had treated approval semantics as purely backend-native. But there is an enforceable shared
outcome, and without it `blocked` means different things per backend. Every interaction resolves to
exactly one of:

```
pre_authorized | denied_by_policy | awaiting_authorized_responder | rejected_unattended
```

Policy *syntax* stays backend-native; this *outcome* is a shared contract. → **ADR-007**, spec §8.

### 4. Fail-closed guardian: controller death terminates the job
*(Codex)*

The sharpest finding. Node cannot reconstruct a lost Job Object handle after a crash. So either jobs
are intentionally non-resumable after controller death, or the helper must accept authenticated
reattachment — at which point it stops being a containment syscall wrapper and becomes a process
supervisor with leases, IPC, status queries, and version negotiation. That is the two-implementation
problem I was trying to avoid.

**Decision: fail-closed guardian.** The helper is tied to the invoking controller; controller death
always kills the job. Recovery marks the attempt `interrupted`, and `resume` starts a **new attempt**
from durable inputs. This is stated as a contract: *the tool does not promise continuation of running
jobs across wrapper crashes.* → **New ADR-008.**

### 5. Attempt identity is separate from job identity
*(Codex)*

Resume and retry must never overwrite a previous attempt's pid, session id, logs, failure, or result.
Job state gains an attempt dimension. → spec §5, §6.

### 6. `status.json` is a projection, not the transactional store
*(Codex)*

One file cannot be both the public machine-readable projection and the authoritative transactional
record. Authoritative lifecycle changes go to an **append-only attempt/event journal**; `status.json`
is an atomically-replaced projection derived from it. Crash points are defined explicitly around
spawn, session creation, snapshot commit, cancellation, and terminal publication. → spec §4, §6.

### 7. `resume` is three distinct operations
*(Codex)*

`continue_backend_session`, `retry_attempt`, and `fork_from_artifacts` have different preconditions
and availability. The engine owns the resume *command* and job lineage; it must never label all three
"resume". → spec §16.

### 8. Worktree isolation is repository-state isolation ONLY
*(Codex)*

An honesty fix with real consequences. A worktree stops the backend from mutating the user's checkout.
It does **not** stop it reading credentials, SSH keys, or arbitrary user files — only the backend's
actual sandbox does that. The docs must not imply otherwise, and `--access read-only` must be scoped
to what the wrapper can genuinely enforce. → spec §12, ADR-004.

### 9. Snapshot commits must avoid hooks and signing
*(Codex)*

A wrapper-owned snapshot commit can trigger user git hooks or fail on unavailable signing/identity
config. Use plumbing commands that bypass hooks and signing, with wrapper-controlled author metadata.
→ spec §12.

### 10. Secrets must be redacted before persistence
*(Codex — genuinely missing)*

Environment snapshots, HTTP error bodies, debug bundles, prompts, logs, and provider responses can
all contain tokens. The failure classifier deliberately reads provider error bodies (§A9), which is
exactly where secrets live. Define redaction before write, restrictive ACLs on the state root, and an
explicit list of diagnostics that are never written. → new spec §20.

---

## ADOPTED — hardening

### 11. Per-job server output capture and long-lived-pipe drain
*(opencode — a concrete gap in my own never-hang section)*

I specified concurrent pipe draining for short-lived children but never said where the long-lived
`opencode serve` process's stdout/stderr goes. If it is piped and not drained, a verbose debug dump
fills the buffer and **the server hangs** — a never-hang violation inside the never-hang design.
Server output is captured to a size-capped, rotating job log, drained continuously for the whole
server lifetime. → spec §13.

### 12. Port discovery must be a machine-readable handshake, not log scraping
*(Codex)*

"Parsing human startup logs is not a contract." If opencode offers no bound-port handshake, reserving
a port introduces a close-then-bind race that must be accepted and **tested** with bounded retries.
Elevated to a phase-gating verification item. → spec §19, ticket 12.

### 13. SSE correctness derives from queryable durable state
*(Codex)*

"SSE plus polling" only reconciles if every consequential event is *also* queryable. A permission can
be created and resolved between polls; an event can be missed on reconnect. Persist the last event id
where supported, and derive correctness from queryable resources — never from event receipt.
→ spec §19, ADR-002.

### 14. Concurrency admission control
*(both reviewers)*

Fan-out multiplies model runtimes, file watchers, caches, provider connections, and memory — not just
process count. Ten small background tasks can become ten servers plus ten agent processes and exhaust
memory or provider quota before any timeout helps. Engine-level global and per-backend concurrency
limits, configurable. → spec §15.

### 15. `doctor` must specify what it actually probes
*(opencode)*

"Smoke test" was unspecified. Per backend: opencode — `GET /global/health`, version, and a **shape
check** on each depended-upon endpoint; Codex — `codex doctor --json` plus version range; Claude —
version plus presence of the expected flags (and note `claude doctor` has no `--json`, so the adapter
builds the envelope itself). Unsupported versions **fail closed**. → spec §10, ticket 6.

### 16. Findings-appendix hardening
*(both reviewers)*

opencode: token truncation can leave the marker present and the JSON incomplete, which would surface
as "no actionable findings" for a diff that has real problems — and users would learn not to trust
it. Model behavior also drifts, e.g. a preamble before the marker.

Codex: parse only the final exact marker; cap appendix size and item count; reject duplicate markers;
validate paths as repository-relative; treat appendix content as untrusted; and keep a distinct
`malformed` status rather than only `findings: null`.

Both adopted. A **preamble before the marker is tolerated**; trailing content after the appendix is
not. Truncated JSON is `malformed`, never "clean". A corpus of real model outputs is a test fixture
from day one. → spec §11, ticket 15.

### 17. Exit code 2 conflates two different failures
*(Codex)*

"Your syntax is wrong" and "this is a valid request your backend cannot serve" are different problems
for an agent. The shell exit code may stay shared, but the machine-readable output must carry a
distinct failure class. → spec §7.

### 18. `backend_state` needs its own schema version
*(Codex)*

The engine may treat the payload as opaque, but recovery needs the matching adapter version to
interpret it. Every adapter state payload carries a version and a migration policy — otherwise it
becomes an unversioned dumping ground. → spec §5.

### 19. Process identity needs an ownership token, not just OS identity
*(Codex)*

pid + creation time + image path reduces PID-reuse mistakes but does not *prove ownership*. Store and
verify a helper-generated random execution token; use OS identity as corroboration only.
→ spec §14, ADR-008.

### 20. Fault-injection tests come before broad feature tests
*(Codex)*

Defined crash points: immediately before and after process spawn, port discovery, session creation,
snapshot commit, cancel request, hard kill, and terminal-state publication. → development guide §4,
ticket 5.

### 21. Native-helper feature-creep guard is a written rule
*(opencode)*

"The rot starts when someone adds 'while we're here, let's also expose the process tree as a JSON
tree.' Each addition is 10 lines and independently reasonable. After five additions, the helper is a
moderate native addon" with a multi-platform prebuild pipeline of its own.

Banned in the helper, explicitly: telemetry, path resolution, string manipulation, business logic,
timeout decisions, cancellation-rung decisions, job state, backend knowledge. Versioned primitives
only (`spawn-contained`, `terminate`, lifecycle notifications). Any expansion is a design-review item.
Binaries ship per architecture with hashes and a compatibility handshake, and **fail closed** when
containment is requested but the helper is missing or incompatible. `taskkill` is an explicitly
**degraded** capability, never a transparent fallback. → ADR-003, ADR-008.

---

## REJECTED

### R1. "Server startup is 5–15 s and will dominate latency"
*(opencode)*

**Rejected on measured evidence.** `opencode serve` was observed healthy in **~2 s** on this host
(study §6), against model turns of 30–90 s in the same session. The reviewer also attributed cost to
"load Node runtime" — opencode is a Bun-built binary, not Node. Provider handshake happens per
*session*, which the CLI path pays too, so it is not a per-job-server cost.

The underlying concern — that fan-out multiplies real resources — **is** adopted as admission control
(#14). What is rejected is the specific magnitude and the implication that the backend choice should
be revisited on latency grounds. This is now a measured item in the opencode adapter ticket rather
than a design change.

### R2. "Ephemeral port exhaustion — 50 jobs on a CI runner exhausts them"
*(opencode)*

**Rejected as stated.** Windows' default dynamic port range is ~16 384 ports; 50 concurrent jobs
consume 50 listening sockets. That is 0.3 % of the range, not exhaustion. Bounded concurrency (#14)
caps it well below any plausible limit anyway.

### R3. "Consider a multiplexed shared server; pick one"
*(opencode)*

**Rejected.** This is precisely the shared-daemon design ADR-002 rejected: one shared failure domain,
version drift, ownership and idle-shutdown problems, ambiguous per-job directory and permission
routing, and a security surface that outlives any single job. The framing that isolation and
efficiency force a choice is accepted; the resolution is to keep isolation and bound concurrency.

### R4. "Run a warmup review on a known-good diff to validate the appendix format before the real one"
*(opencode)*

**Rejected as a per-call mechanism** — it doubles the cost and latency of every review to guard
against a failure the parser can already detect after the fact. The legitimate part of the concern —
that a malformed appendix must never read as clean, and that format stability needs proving — is
adopted as #16, in the parser and in a corpus fixture, not as a runtime pre-flight.

### R5. "opencode 1.19.0 renames `/session/status` → 404 → classified unknown → 'dcli broken'"
*(opencode)*

**Rejected as already-designed-for**, not as wrong. The scenario is real, but capability probing at
startup with fail-closed version rejection (spec §10) stops it before a job is created — the user
gets "opencode 1.19.0 is not supported; supported range is …", not a mystery 404. The reviewer's
useful addition, that "smoke" was never specified, is adopted separately as #15.

---

## Net effect

The design's safety instincts survived review; its **build order and its crash-recovery contracts did
not**. Two new ADRs, one reversed phase order, one explicit non-promise (no continuation of running
jobs across wrapper crashes), and roughly a dozen hardening items now folded into the spec.

Codex's own one-line verdict is a fair summary:

> "The design has strong safety instincts, but its build order risks an HTTP-shaped engine, and its
> opencode and native-helper lifecycles lack the crash-recovery contracts needed to make those
> guarantees real."
