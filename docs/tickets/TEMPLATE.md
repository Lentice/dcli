# NN — <one line: the outcome, or the defect in the user's terms>

**Tier:** <why this matters — trust, correctness, safety, ergonomics — in one or two sentences>
**Filed from:** <where this came from: a dogfooding run, another ticket's Notes, a review finding>

<!-- Status and "Blocked by" belong in the README table, not here. See "One place owns status" in
     docs/tickets/README.md. -->

---

## Symptom / Goal

What is observably wrong today, or what does not exist yet. Written so a reader who has never seen this
code knows what they would witness. For a defect, state what was actually observed, not what was inferred.

## Root cause

For a defect: the mechanism, with the file and the code that causes it. Quote the few lines that matter.
Omit this section for a pure feature ticket.

## Binding constraints — quoted, do not go looking for them

`docs/tickets/00-onboarding.md` is required reading and carries the five invariants, so do not repeat
them here. Quote only what is specific to *this* ticket: the `docs/design-spec.md` clauses it
must satisfy, the exit codes and `status.json` fields it touches, the `docs/reference/cli-*.md` facts it
depends on. Quote the text inline. An implementer must not have to go hunting, and must not have to
guess which clause applies.

## Files to read and trace first

List every file the implementer needs, each with what to look for and why. Include the *call sites*, not
just the file that gets edited — the commonest failure is changing a function without finding who
depends on its current behavior.

Line numbers are navigation hints only; they drift. The code shapes and function names are the spec.

## What to build

The scope, in numbered subsections. Be concrete: signatures, constants, field names, which file each
change lands in. Where a design decision has already been made, state it as decided and give the reason,
so the implementer does not reopen it.

## Non-goals

Each one with its reason. A non-goal without a reason gets re-litigated by the next reader, and a
plausible adjacent change with no stated reason to skip it is how a two-day ticket becomes a week.

## Acceptance criteria

- [ ] **A.** ...
- [ ] **B.** ...
- [ ] **Z.** `npm run check` green; `README.md`, `docs/reference/*` and `integration/source/*` updated in
  the same commit where the change is user-visible or agent-visible.

Each criterion is a statement about observable behavior that someone else could check. "Handles errors
properly" is not one.

## Agent checks

Executable commands with their expected output, so the implementer can verify without judgment calls.
This is what makes a ticket safe to hand to an agent that cannot evaluate its own work.

```bash
# What this proves, in one line:
<command>
# expect: <the exact output, or the property the output must have>
```

Include the negative checks — the greps that must return *nothing*. "This change did not leak into
`core/`" is usually the single most valuable line in this section.

## Notes

(Left empty by the author. The implementer fills it in: what was changed and where, build and suite
results, the Agent checks' actual output, any deviation from this ticket and why, and anything
discovered that contradicts the docs.)
