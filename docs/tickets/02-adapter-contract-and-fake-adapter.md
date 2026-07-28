# 02 — Fact-based adapter contract + fake adapter

**Blocked by:** 01
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), then
[ADR-007](../2026-07-28-architecture-decisions.md#adr-007) — the reasoning behind why this contract is
fact-based. Everything you need to *build* is inlined below.

---

## Purpose

Write the adapter contract down **before any real adapter exists**, and build a deterministic fake
adapter that satisfies it. After this ticket, the entire engine can be built and tested with no backend
installed and no tokens spent.

## Why it matters — read this part carefully

This ticket is the direct remedy for the single biggest risk two independent reviewers found in the
design. The risk:

> If the engine and the opencode adapter are built together, HTTP/session concepts become the de facto
> adapter interface — server readiness, event-stream reconciliation, permission queues, HTTP abort,
> "terminal session state". Codex and Claude Code are single-shot supervised child processes with no
> server and no session API. They would then need to *fake* sessions, or the engine would grow a
> parallel synchronous path — which violates invariant 1.

The defense is to fix a vocabulary that is natural for **both** shapes, and to keep the decision about
"is this job finished?" entirely inside the engine.

## Facts you need

- opencode is driven over HTTP with an event stream, a queryable session status (`idle`/`busy`/`retry`),
  a graceful session abort, and endpoints that expose *pending permission and question requests*.
- Codex is `codex exec --json`: prompt on stdin, NDJSON on stdout, final message written to a file,
  process exits. **No server, no session status, no graceful cancel, no way to answer a prompt.**
- Claude Code is `claude -p --output-format stream-json`: similar single-process shape, with a
  caller-assigned session id.

A vocabulary that only fits the first is the failure mode.

## Design

### The contract document

Write `docs/adapter-contract.md`, versioned (`contract_version: 1`). It defines every operation below
with explicit pre- and postconditions. This document is the authority; the code follows it.

### Operations

```
GetIdentity()                        → { backend, adapter_version, state_schema_version }
DetectVersion()                      → installed backend version string
ProbeCapabilities()                  → effective manifest (see ticket 12)
DeclareCancelRungs()                 → ordered array of rung names this backend really has
ValidateRequest(request)             → throws a typed rejection; MUST NOT create a job
PrepareInvocation(attempt, request)  → writes backend-owned input/config artifacts
Start(attempt)                       → begins execution; returns an execution handle
Observe(attempt)                     → async iterator of FACTS
SendPrompt(attempt, prompt)          → delivers the prompt
Resume(attempt, kind, prompt)        → kind ∈ continue_backend_session | fork_from_artifacts
Respond(interactionId, decision)     → OPTIONAL; only if capability declares it
RequestCancel(attempt, rung)         → performs ONE declared rung
CollectResult(attempt)               → { text, usage, backend_session_id }
CollectDiagnostics(attempt)          → redacted diagnostic bundle
Dispose(attempt)                     → releases transients
Recover(attempt)                     → after a controller crash
```

Postconditions that must be stated per adapter, not left implicit:

- `RequestCancel(attempt, rung)` — what is guaranteed to have stopped when it returns.
- `Dispose(attempt)` — what is guaranteed released; must be safe to call twice.
- `Recover(attempt)` — **the attempt is afterwards either terminal or `interrupted`. Never `running`.**

### The fact vocabulary — closed set

```
started{ backend_pid?, backend_session_id? }
assistant_text{ message_id, text }
reasoning{ message_id }                       // presence only; content not persisted by default
tool_invoked{ call_id, tool, summary }
tool_result{ call_id, ok, summary }
interaction_pending{ interaction_id, kind: 'permission'|'question', detail }
interaction_resolved{ interaction_id, outcome }
usage_reported{ tokens{ input, output, reasoning, cache_read, cache_write, total }, cost? }
backend_status{ state: 'busy'|'idle'|'retrying', attempt?, next_at? }
backend_error{ class_hint?, structured_payload }
process_exited{ code }
stream_closed{ reason }
```

Rules:

- This set is **closed**. Adding a fact type is a contract-version change, not an adapter detail.
- An adapter emits a subset. Codex will never emit `backend_status`; opencode will. That asymmetry is
  expected and the engine must tolerate it.
- **No fact means "the job is done".** `process_exited` and an idle `backend_status` are *evidence*.

### Interaction outcome — shared enum

```
pre_authorized | denied_by_policy | awaiting_authorized_responder | rejected_unattended
```

Interaction *mechanics* are backend-specific; this outcome is shared, because without it "blocked"
would mean different things per backend. `rejected_unattended` is the terminal blocked case: something
must answer and nothing is authorized to.

### The fake adapter (`adapters/fake/`)

Driven by a small script object so tests can produce any shape deterministically:

```js
{ facts: [ /* fact objects, optionally with { delayMs } */ ],
  exitCode: 0,
  declaredRungs: ['hard_kill'],
  capabilities: { /* manifest */ },
  behaviors: { hangAfter: 'started', failValidateOn: '--variant', spawnGrandchild: true } }
```

Required scriptable scenarios (later tickets depend on these existing):

1. Clean run producing final text.
2. Tool-using run: `tool_invoked` → `tool_result` → `assistant_text`.
3. Exits 0 with **no** assistant text (drives exit code 11).
4. `backend_error` with a structured payload (drives classification).
5. `interaction_pending` that is never resolved (drives the blocked path).
6. Slow run (drives timeouts).
7. Immediate crash before any fact (drives worker-launch failure).
8. Declares one rung; declares three rungs where the first two fail.

### The contract test suite (`tests/contract/`)

One suite, parameterized over an adapter, that every adapter must pass unmodified. It asserts the
operations honor their postconditions, only closed-set facts are emitted, `Recover` never leaves an
attempt `running`, and cancellation works for both a one-rung and a three-rung adapter.

## Pitfalls

- **Do not put "session" in the vocabulary.** `backend_session_id` is an opaque string on `started`;
  there is no session lifecycle in the contract.
- **Do not let `Observe` yield transport objects.** No HTTP responses, no raw NDJSON lines. Parse in the
  adapter; emit facts.
- **Do not give the fake adapter conveniences no real backend has.** If the fake can do something
  Codex cannot, the contract will drift toward the fake.
- `Dispose` and `Recover` must be idempotent. Later fault-injection tests call them repeatedly.

## Checklist

- [ ] `docs/adapter-contract.md` exists with `contract_version: 1` and every operation's pre/postconditions.
- [ ] The fact vocabulary is implemented as a closed set with a validator; an unknown fact type is a
      hard error in tests.
- [ ] No operation signature mentions HTTP, sessions-as-lifecycle, streams, or process internals.
- [ ] `Respond` is gated by a declared capability and absent otherwise.
- [ ] `DeclareCancelRungs()` exists and returns an ordered array.
- [ ] `Recover()`'s postcondition is documented and tested: terminal or `interrupted`, never `running`.
- [ ] The interaction-outcome enum is defined once in `core/` and used by all adapters.
- [ ] `adapters/fake/` implements the contract and supports all eight scenarios above.
- [ ] `tests/contract/` exists, is parameterized over an adapter, and the fake adapter passes it.
- [ ] The lifecycle `--json` envelope shape is specified with `schema_version` (fields may be `null`,
      never omitted).
- [ ] A test asserts adapters cannot declare terminality — there is no API for it.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

Then, as a design check, write down in Notes how a Codex adapter would satisfy every operation. If any
operation has no sensible Codex answer, **the contract is wrong** — fix it now, in this ticket. That
check is the whole point of the ticket.

## Definition of done

The contract document exists, the fake adapter passes the contract suite, and the written Codex
walkthrough in Notes shows every operation is satisfiable by a single-shot child process.

## Commit message

```
feat: fact-based adapter contract and deterministic fake adapter
```

## Notes

Record the Codex walkthrough here, plus anything that contradicts the docs.
