# Writing a ticket

A ticket is written by an agent or engineer holding the full context, and implemented by one holding
none. Every rule below exists to survive that gap. Use [`TEMPLATE.md`](TEMPLATE.md) for the sections.

You do not need this file to *implement* a ticket — read [`00-onboarding.md`](00-onboarding.md) instead.

**Size.** One ticket delivers **one outcome**, sized half a day to two days. If it grows past that,
split it before writing it — not during implementation, when the implementer has no standing to decide
where the seam goes.

**Self-contained.** Written to be picked up cold, with no prior context and no chance to ask a follow-up
question. The test is mechanical: could an implementer who reads only `00-onboarding.md` and this one
file finish it and know they were right?

**Quote the constraints; do not cite them.** The design-spec clauses, the exit codes, the
`status.json` fields, the `docs/reference/cli-*.md` facts this ticket depends on go *inside* the ticket
as quoted text. Do not rely on the implementer finding them, and do not make them guess which clause
applies. The five invariants are the exception — `00-onboarding.md` already carries them.

**Name the files to read and trace, including the call sites.** A ticket that names only the file to be
edited has pushed the hardest part of the job — finding who depends on the current behavior — onto the
person least equipped to do it.

**Non-goals carry their reasons.** A non-goal with no reason gets re-litigated by the next reader.

**Acceptance criteria are observable; Agent checks are executable.** Prose criteria are for humans
triaging the outcome. The Agent checks section is commands plus their expected output, including the
greps that must return nothing — that is what lets an agent verify its own work instead of asserting
that it is done.

**Check the rejected record before writing.** `docs/architecture-review-record.md` has a `REJECTED`
section, each ADR in `docs/architecture-decisions.md` records its rejected alternatives, and ticket 78 is
closed-not-implemented by decision. If a ticket would reopen one of those, that is allowed, but the
ticket must **state the override and its new evidence in its own text**.

**Never edit a closed ticket.** Its Notes are the historical record. An override lives in the new ticket.
This protects the ticket's scope, decisions and Notes — not a path or a status that has since become
false.

**A contract change has its replacement text written in advance.** Invariant #4 is append-only: exit
codes and `status.json` fields cannot be renamed or repurposed later. So a ticket that changes a
contract states the exact new clause and where it goes — that decision belongs to the author, not to
the implementer at 2am.

**Numbering.** Take the highest number in [`README.md`](README.md) and add one, at the moment you write
the file, and confirm no file in this directory already uses it. Do not reserve numbers in advance:
another agent may be writing tickets in this repository at the same time.

**Status and blockers live in the README table only** — never also in the ticket file. Two copies of the
same fact drift silently, and drift here is worse than useless: a ticket file that still says `ready`
after the work shipped tells the next cold reader to build it again.

**Commit the ticket with the README row** that announces it, in one commit, e.g.
`docs: add ticket 87 — <slug>`.
