# 16 — Contract parity gate across both slices

**Blocked by:** 14, 15
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md) §3 (invariants),
[ADR-007](../2026-07-28-architecture-decisions.md#adr-007),
[review record](../2026-07-28-architecture-review-record.md) "Where the two reviewers independently agreed".

---

## Purpose

Prove — and then permanently enforce — that the adapter contract is not shaped by any one backend. This is the
gate that decides whether the whole "one project, three backends" premise holds.

## Why it matters

Everything after this ticket assumes the boundary is sound. If it is not, this is the last cheap moment to
find out: two thin adapters exist, nothing depends on them yet, and no feature work has been built on top.

If this gate fails, the correct response is **not** to special-case a backend. It is to change the contract,
or — if the contract genuinely cannot serve both shapes — to invoke the
[ADR-001 kill criteria](../2026-07-28-architecture-decisions.md#kill-criteria--when-to-abandon-adr-001-and-split-into-three-projects)
and reconsider whether these should be one project at all. Say so plainly rather than bending the design.

## Design

This ticket adds almost no production code. It adds **enforcement**.

### 1. The parity suite

Run the single contract suite over *both* real adapters plus the fake, in one invocation, reporting per
adapter:

```
contract (fake):     34 passed
contract (opencode): 34 passed
contract (codex):    34 passed
```

The suite source must be **identical** for all three. Any adapter needing a skipped or altered assertion is a
finding, not an accommodation — record it and fix the contract.

### 2. The no-conditional test

A static check over `core/`: no identifier or string literal naming a backend (`opencode`, `codex`, `claude`),
except in an explicit allowlist of backend-registry files whose only job is mapping a name to an adapter
module. Keep that allowlist tiny and reviewed.

### 3. The asymmetry ledger

Write `docs/adapter-asymmetry.md` recording, for every contract operation and every fact type, which backends
support it and which do not — with the reason. This is the document that later prevents someone from
"helpfully" unifying something that must stay separate.

Expected asymmetries at this point (all legitimate):

| Concern | opencode | codex |
|---|---|---|
| `backend_status` fact | emitted | never emitted |
| `Respond` | supported | impossible |
| cancel rungs | 3 | 1 |
| graceful abort | yes | no |
| structured output | broken | works (`--output-schema`) |
| effort surface | `--variant` (unbounded string) | `-c model_reasoning_effort=` (enum, not a flag) |

### 4. Failure criteria — decide explicitly

The gate **fails** if any of these is true. Do not proceed to ticket 17 without resolving it:

- The contract suite required a backend-specific skip or alteration.
- `core/` needed a backend conditional.
- Either adapter had to invent a concept its backend does not have (a fake session, a synthetic idle status,
  a no-op cancel rung reported as success).
- The engine grew a second execution path for one adapter's shape.

## Pitfalls

- Do not let "the test is a bit different for Codex" pass. That *is* the failure this ticket exists to catch.
- A no-op rung reported as a success is worse than declaring one rung — it makes cancellation lie.
- Do not weaken the static check by allowlisting whole directories.

## Checklist

- [ ] One contract suite runs over fake, opencode, and codex adapters, reported per adapter.
- [ ] The suite source is **byte-identical** across all three runs; a test asserts no per-adapter branching
      inside the suite.
- [ ] No adapter requires a skipped or altered assertion. Any that does is recorded as a gate failure.
- [ ] A static check proves `core/` contains no backend name outside a tiny reviewed registry allowlist.
- [ ] `docs/adapter-asymmetry.md` exists, covering every operation and fact type, with reasons.
- [ ] Every asymmetry in the table above is recorded as a **capability** difference, never a required-operation
      difference.
- [ ] No adapter fabricates a concept its backend lacks; a test asserts codex emits no `backend_status` and
      declares `Respond` unsupported.
- [ ] The four failure criteria are each explicitly evaluated and the result written in Notes.
- [ ] The parity suite runs in the full suite and gates the build.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

Read the per-adapter contract lines. All three must show the same assertion count.

## Definition of done

All three adapters pass the same unmodified contract suite, the static no-conditional check passes, the
asymmetry ledger exists, and the four failure criteria are explicitly evaluated in Notes.

**If the gate fails, the ticket's deliverable is the written analysis of *why*, plus a proposed contract
change — not a workaround.**

## Commit message

```
test: contract parity gate across opencode, codex, and fake adapters
```

## Notes

### Failure-criteria evaluations

**Criterion 1 — Contract suite required a backend-specific skip or alteration.**

PASS. The shared suite (`tests/contract/suite.js`) contains zero adapter-specific branching.
No adapter name string appears outside comments. All 14 assertions run identically for fake,
opencode, and codex adapters. The `Respond` test uses dynamic capability negotiation via
`ProbeCapabilities()` — a legitimate runtime query, not a hardcoded skip. The suite's `label`
parameter is used only for human-readable reporting; it never drives conditional logic.

**Criterion 2 — `core/` needed a backend conditional.**

PASS. The parity gate's static scan (and the pre-existing
`tests/adapters/codex/no-backend-conditional.test.js`) both confirm: no file in `core/`
references any backend name (`opencode`, `codex`, `claude`) outside comments. The allowlist
stays empty.

**Criterion 3 — Either adapter invented a concept its backend does not have.**

PASS. Codex correctly throws for `Respond` (never declares the capability), declares exactly
1 cancel rung (`hard_kill`), and never fabricates a `backend_status` fact. Opencode declares
3 cancel rungs matching its real HTTP API surface (`session_abort`, `server_dispose`,
`hard_kill`). No adapter fabricates a synthetic idle status, fake session, or no-op rung
reported as success.

**Criterion 4 — The engine grew a second execution path for one adapter's shape.**

PASS. The shared suite is byte-identical source required at runtime from `suite.js`. No change
to `core/` or the adapter contract was needed. The zero-allowlist static scan proves no
backend name reached production core code.

**Verdict: gate passes.** The single-project, three-adapter premise holds at this checkpoint.
Proceed to ticket 17.
