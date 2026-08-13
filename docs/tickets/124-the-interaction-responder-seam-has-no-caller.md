# 124 — the interaction responder seam has no product caller, and three of its four outcomes cannot be produced

**Status:** ready
**Blocked by:** 123 — that ticket removes the opencode half of this seam (`_automationPolicy` and its
branches). Land it first, then re-measure what is left here; some of the surface below disappears with it.
**Tier:** Cleanup, and a contract question. `Respond()` is part of the adapter interface — all four
adapters implement it — but nothing in `core/` ever calls it. `core/interaction-outcome.js` defines four
outcomes and only one is reachable. So the interface obliges every future adapter to implement a method
the engine never invokes, and `status.json` advertises three states no job can be in. Neither is a bug
today; both are a bill every future adapter author pays.

**Filed from:** an observation in the delegated audit behind ticket 123 (2026-08-13), deliberately left
out of that ticket's scope, then verified here. Recorded in 123's Notes.

---

## Symptom / Goal

Two facts, both verified:

**Nothing calls `Respond()`.** It is implemented in `adapters/opencode/adapter.js`,
`adapters/claude/adapter.js:346`, `adapters/codex/adapter.js:470`, and `adapters/fake/adapter.js:173`.
No file under `core/` or `cli/` invokes it. The only callers are tests.

**Three of four interaction outcomes are unproducible.** `core/interaction-outcome.js` defines
`pre_authorized`, `denied_by_policy`, `awaiting_authorized_responder`, and `rejected_unattended`. Only
the last is emitted anywhere. The first two describe a policy decision, and after ticket 123 there is no
policy in the codebase at all. `awaiting_authorized_responder` describes a job parked waiting for someone
to answer — which is exactly the stall the current unattended design exists to prevent, so nothing may
produce it by design.

Goal: decide whether the responder seam is a capability this project intends to have, and make the code
say the answer either way. Right now the code says "yes, partially built", and every reader has to
discover otherwise.

## Root cause

The seam was designed for an interactive-delegation model the project later decided against. The engine
side of that model was never built, and the abstraction it required — one interface method, one
four-valued enum — stayed. `AGENTS.md`'s own rule applies: an interface with no caller is not a contract,
it is an unowned obligation.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §7, on the exit-code and class tables:

> Stable and append-only. ... adding a class or a code is allowed, changing an existing value is not.

The question this ticket must settle is whether `InteractionOutcome`'s values are covered by that rule.
They are not exit codes or failure classes, but `rejected_unattended` ships inside job records and the
agent skills name it. **Determine before deleting anything whether any of the three unproducible values
has ever been written to a `status.json` on disk or named in a shipped document.** If one has, it stays —
an unproducible value that a reader may still encounter in an old record is not dead, it is historical.
Write what you found in Notes; this determination is the substance of the ticket, not a preliminary.

Invariant 2 also holds: whatever survives, adapters emit facts and the engine decides state. A future
responder would not change that.

## Files to read and trace first

- `core/interaction-outcome.js` — the enum and its validator. Small; read it all.
- `core/fact-types.js` — `interaction_pending` / `interaction_resolved` validation. These facts *are*
  produced and must keep working.
- `core/reducer.js` — what the engine does with a resolved interaction, and note
  `interaction_reject_failed` in `STREAM_CLOSED_ERROR_REASONS`, which is live.
- Every adapter's `Respond()` — establish that none is called from `core/` before concluding it.
- `docs/design-spec.md` — the adapter interface definition. If `Respond()` is specified there as a
  required method, that specification is the thing to change, not just the implementations.
- `docs/architecture-decisions.md` — search for the interactive-delegation decision. If the seam was kept
  deliberately for a rejected-but-revisitable option, that is an argument for keeping it *with a comment
  saying so*, and this ticket becomes a documentation ticket.

## What to build

Land 123 first. Then, in order:

### 1. Establish the intent

Read the architecture record for whether an interactive responder is a rejected option or a deferred one.
Record the finding in Notes with a citation. **This decides the rest of the ticket**, and it is a reading
task, not a judgement call — if the record is silent, say that explicitly rather than inferring.

### 2a. If the responder is rejected

Remove `Respond()` from the adapter interface specification and from all four adapters. Remove the three
unproducible outcomes, unless step "Binding constraints" found one persisted or documented. Keep
`interaction_pending` / `interaction_resolved` and `rejected_unattended` exactly as they are — they are
live contract.

### 2b. If the responder is deferred

Keep the surface and make its status explicit: one comment at the definition of `Respond()` in the
interface specification and one at `core/interaction-outcome.js` stating that the method has no engine
caller today, which outcomes are currently producible, and what would have to be built to change that. A
future adapter author must not have to run this audit again.

Either way, do not leave the seam in its current state, where the only way to learn any of this is to
grep for callers.

### 3. Documentation in the same commit

Whichever branch was taken: `docs/design-spec.md`'s adapter interface, and
`docs/engineering/backend-pitfalls.md` if a trap was found worth naming. If the outcome enum changes,
check `integration/source/*` for any mention and regenerate with
`node scripts/generate-integration.js`, re-run `install.ps1`, and confirm installed copies byte-match.

## Non-goals

- **Building an interactive responder.** If step 1 finds it deferred, it stays deferred; this ticket
  documents that, it does not implement it.
- **Changing the auto-rejection behavior, its facts, or `rejected_unattended`.**
- **Re-doing ticket 123's work.** The opencode-specific policy path is 123's; this ticket is the
  cross-adapter seam that remains after it.
- **Auditing the rest of the adapter interface for unused methods.** If this ticket suggests the interface
  has more speculative members, that is a separate ticket.

## Acceptance criteria

- [ ] **A.** Notes state, with a citation, whether an interactive responder is rejected or deferred, and
  which branch (2a or 2b) was taken and why.
- [ ] **B.** Notes state, per unproducible outcome value, whether it was ever persisted to a `status.json`
  or named in a shipped document — the evidence, not a conclusion alone.
- [ ] **C.** `interaction_pending`, `interaction_resolved` and `rejected_unattended` are unchanged, proven
  by the existing interaction tests passing unmodified.
- [ ] **D.** If 2a: `grep -rn "Respond(" core/ cli/ adapters/` returns nothing, and the adapter interface
  specification no longer lists the method. If 2b: the two required comments exist and name what is
  producible today.
- [ ] **E.** No backend-specific conditional entered `core/` (invariant 1).
- [ ] **Z.** `npm run check` green; tracker table regenerated via `node scripts/generate-tickets-table.js`;
  docs updated in the same commit, with installed skill copies verified byte-identical if the generated
  skills changed.

## Agent checks

```bash
# The premise, re-measured after 123 lands:
grep -rn "Respond(" core/ cli/
# expect: no output (this is the fact the ticket rests on; if it changed, stop)

# Which outcomes anything actually emits:
grep -rn "pre_authorized\|denied_by_policy\|awaiting_authorized_responder" adapters/ core/ tests/
# expect after 2a: no output. After 2b: only the definition and the explanatory comment.

# The live half is untouched:
grep -rn "rejected_unattended\|interaction_reject_failed" core/ adapters/
# expect: unchanged from before this ticket
```

## Notes

(Empty — the implementer fills this in. Steps 1 and "Binding constraints" both write here; a merged
implementation with an empty Notes section has not done the ticket.)
