# 104 — Generate the ticket tracker table, with a staleness gate

**Tier:** Process integrity. The tracker's own stated trigger has fired: twelve tickets are open, past the
documented threshold of ten. The failure mode it was written to prevent is specific and expensive — a
sibling project accumulated twelve item files claiming work was still waiting while its tracker had them
finished, and an agent reading one of those files cold would have implemented it a second time.
**Filed from:** the trigger condition recorded in [`README.md`](README.md), fired 2026-08-10.

---

## Symptom / Goal

[`docs/tickets/README.md`](README.md) says:

> **When this table becomes a chore, generate it.** The trigger is more than ten open tickets, or the
> first time the table and a ticket file disagree. At that point the ticket files become the source of
> truth and this table is produced from them, with a staleness check in `npm run check` — the same shape
> as the generated-skills gate in `AGENTS.md`. Do not build that machinery before the trigger.

Twelve tickets are open. The table is still maintained by hand, and there is nothing that would notice if it
drifted from the files.

Goal: the ticket files become the source of truth for status and blockers; the table is generated from them;
`npm run check` fails when the checked-in table does not match what the generator would produce.

## Root cause

Not a defect — a deliberately deferred piece of machinery whose trigger has now been met. Build it as
specified, not larger.

## The design decision this ticket must make first

Status currently lives **only** in the table. `TEMPLATE.md` has no status field, and
[`README.md`](README.md) explains why:

> A new ticket does not repeat them in its own file, because two copies of the same fact drift and nothing
> here would catch it.

Inverting the source of truth means status moves **into** the ticket files. That is not a contradiction of
the rule above — the rule forbids *two* copies, and after this ticket the table is a derived artifact, not a
second copy. But it means:

- `TEMPLATE.md` gains a status field, and `AUTHORING.md`'s guidance changes to match.
- Every open ticket gains one.
- Tickets 78–86 carry a frozen `**Status:**` line already, under the "never edit a closed ticket" rule. The
  generator must read those rather than requiring them to be rewritten. If their format differs from the new
  one, **support both in the parser** rather than editing a closed ticket.

Decide the field's format before writing anything else, write it into Notes, and keep it machine-parseable:
a small front-matter block or a fixed `**Status:** <value>` / `**Blocked by:** <ids>` pair. Do not invent a
YAML dependency; this repository is plain Node with no build step.

## Binding constraints — quoted, do not go looking for them

From `AGENTS.md`, the shape to copy:

> **Docs ship in the same commit as the behavior** … Re-run the installer after user-facing changes and
> verify installed copies **byte-match** the repo.

The precedent is `scripts/generate-integration.js` plus `tests/integration/generate.test.js`, whose gate
works by regenerating and comparing before asserting anything else:

```js
// Verify the checked-in generated tree still matches the source generator before
// asserting semantics against it. This catches source changes that were not
// regenerated, rather than testing only whatever stale files happen to exist.
check();
```

Match that structure exactly. A gate that only greps for the *presence* of a row is the weaker check the
existing suite already warns about at `tests/integration/generate.test.js:170`.

The status vocabulary is fixed by [`README.md`](README.md) and must not change:
`ready`, `in progress`, `blocked`, `done`, `closed, not implemented`, plus `reference` for
[`00-onboarding.md`](00-onboarding.md).

## Files to read and trace first

- `docs/tickets/README.md` — the table, both sections, the "One place owns status" rule, the status
  vocabulary table, and the prose paragraphs around the tables that are **not** generated.
- `docs/tickets/TEMPLATE.md` and `AUTHORING.md` — both change.
- `docs/tickets/78-*.md` through `86-*.md` — the frozen `**Status:**` lines the parser must accept as-is.
- `docs/tickets/92-*.md` through `103-*.md` — the tickets that gain a status field.
- `scripts/generate-integration.js` — the generator pattern, especially its `check()` export.
- `tests/integration/generate.test.js` — the gate pattern, including the comment at `:170` about why a
  presence grep is not enough.
- `package.json` — how `npm run check` composes lint and the full suite.

## What to build

### 1. A status field in each ticket file

Format decided above. Every open ticket gets one, matching the table's current value exactly — the migration
must be a no-op for the rendered table.

### 2. `scripts/generate-tickets-table.js`

Reads `docs/tickets/*.md`, parses id, title, status and blockers, and rewrites **only the table rows** in
`docs/tickets/README.md`, between explicit markers. The surrounding prose is hand-written and must survive
untouched. Export a `check()` that returns whether the checked-in file matches, exactly as
`generate-integration.js` does.

Ordering: the Open table keeps its recommended order (so ordering is data in the ticket file, not the
generator's opinion); the Closed table stays grouped as it is today.

### 3. A staleness gate in the suite

A test that calls `check()` first and fails with a message naming the drifted rows and telling the reader to
run the generator. It must fail if a ticket's status changes and the table is not regenerated, **and** if a
row is edited by hand.

### 4. Documentation

`AGENTS.md`'s tickets row, `README.md`'s "When this table becomes a chore" paragraph (it is now history —
say the trigger fired and what replaced it), `TEMPLATE.md`, and `AUTHORING.md`.

## Non-goals

- **A ticket database, an issue tracker, or a CLI to mutate ticket status.** The files are edited by hand;
  only the table is derived.
- **Changing the status vocabulary**, or adding priority, assignee, estimate or dates. The five values plus
  `reference` are what the table has and what it needs.
- **Editing any closed ticket** (78–91) to fit a new format. The parser accommodates them. This rule is in
  `00-onboarding.md` and this ticket is not an exception to it.
- **Generating the prose.** The paragraphs explaining why closed tickets stay listed, and the "A closed
  ticket is not necessarily an implemented one" warning, are hand-written and load-bearing.
- **Touching `scripts/generate-integration.js`.** Two generators is correct here; one script that does both
  would couple the agent-facing artifacts to the developer-facing tracker.

## Acceptance criteria

- [ ] **A.** Every ticket file carries a machine-parseable status; closed tickets 78–91 are unedited.
- [ ] **B.** `node scripts/generate-tickets-table.js` reproduces the current table **byte-for-byte** before
  any status change — the migration is provably a no-op.
- [ ] **C.** Prose outside the table markers is untouched by the generator, asserted by a test.
- [ ] **D.** `npm run check` fails when a ticket's status is changed without regenerating, and the failure
  message names the drifted ticket and the command to run.
- [ ] **E.** `npm run check` fails when a table row is hand-edited to disagree with its ticket file.
- [ ] **F.** The gate regenerates and compares; it does not merely assert a row is present.
- [ ] **Z.** `npm run check` green; `AGENTS.md`, `docs/tickets/README.md`, `TEMPLATE.md` and `AUTHORING.md`
  updated in the same commit.

## Agent checks

```bash
# The migration changed no rendered output.
git stash && node scripts/generate-tickets-table.js && git diff --exit-code docs/tickets/README.md
# expect: no diff at the point the generator is introduced

# The gate actually catches drift.
sed -i 's/ready/blocked/' docs/tickets/102-unix-process-group-containment.md && npm run check
# expect: FAILS, naming ticket 102
git checkout docs/tickets/102-unix-process-group-containment.md

# Closed tickets were not edited.
git diff --name-only HEAD~1 -- docs/tickets/7*.md docs/tickets/8*.md docs/tickets/9[01]*.md
# expect: nothing

npm run check
# expect: green
```

## Handoff

**Extra reading, beyond `AGENTS.md` and `00-onboarding.md`** — `docs/tickets/AUTHORING.md`,
`scripts/generate-integration.js` and `tests/integration/generate.test.js` (the pattern to copy, including
the comment at `:170`). Nothing else.

**Implementation order:**

1. Decide the status field format and write it into Notes **before** editing any ticket. Every later step
   depends on it and changing it afterwards means touching every file twice.
2. Write the generator against the tickets *as they are today*, driving it from a hand-written mapping, and
   prove criterion B: it reproduces the current `README.md` byte-for-byte.
3. Only then add the status fields to the ticket files and switch the generator to read them. Criterion B
   must still hold — the diff at this step should be zero.
4. Add the gate. Prove it fails (criterion D) before proving it passes.
5. Update the four documents.

**Running tests while you work:**

```bash
node tests/integration/generate.test.js
npm run check
```

**Traps specific to this ticket:**

- **The migration must be a byte-for-byte no-op.** If the generated table differs from today's, you have
  either lost information or changed the format — both make it impossible to tell whether the generator is
  correct. Fix the generator, do not accept the new output.
- **Do not edit a closed ticket.** 78–91 are frozen; the parser accommodates their existing
  `**Status:**` lines. This is a rule in `00-onboarding.md`, not a preference.
- The prose between and around the tables is hand-written and carries the reasoning for why closed tickets
  stay listed. Markers must bound the generated region tightly.
- **A presence grep is not a gate.** `tests/integration/generate.test.js:170` records that exact weakness in
  the existing checker. Regenerate and compare.
- The status vocabulary is fixed. If a ticket needs a state the five values cannot express, that is a finding
  for Notes and a conversation, not a sixth value added in passing.

**Commit message:**

```
ticket 104: generate the ticket tracker table with a staleness gate
```

## Notes

(Left empty by the author.)
