# 113 — `cleanup --scrub-session-ids` must survive journal replay

**Status:** ready
**Blocked by:** —
**Tier:** A privacy operation that mutates only the projection is undone by the next
regeneration: the command reports a scrubbed record while subsequent normal reads resurrect the
value. For a session-id scrub, that is a privacy failure, not a cosmetic one.
**Filed from:** 2026-08-11 dual-backend audit (codex F-5; verified with a terminal temp job whose
journal contained a session id — scrub nulled the raw projection, the next regenerated status
restored it)

---

## Symptom / Goal

`dcli cleanup --scrub-session-ids` sets `status.backend_session_id = null` and rewrites the
projection (`core/commands/cleanup.js:204-214` via `store.writeStatusRecord`,
`core/job-store.js:217-225`). The journal — the authoritative, append-only record — still
contains the session id in the attempt/launch events, and regeneration replays it
(`core/job-store.js:361`: `if (d.backend_session_id !== undefined) updated.backend_session_id =
d.backend_session_id;`). Any later status read that regenerates from the journal (e.g. after
reconciliation touches the record) restores the scrubbed value.

## Root cause

The scrub writes to derived state while the authoritative source is append-only and unmodified —
the exact failure mode the journal+projection split exists to prevent.

## Binding constraints — quoted, do not go looking for them

`AGENTS.md` invariant 4: "Contracts are append-only. Never rename or repurpose an exit code or a
`status.json` field." — the fix must add a journal event and a reducer rule, never rewrite or
delete journal entries.

`docs/design-spec.md` §5: "`backend_state` is the **only** place backend-specific data may live" —
the session id is a shared field (`backend_session_id`), not backend_state, so the clear stays in
the shared field.

## Files to read and trace first

- `core/commands/cleanup.js:200-216` — the scrub branch: eligibility (terminal only), the
  direct projection write, `dryRun` handling.
- `core/job-store.js` — `journalTransition` (the append), the replay reducer (`:340-379`,
  especially `:361`), `regenerateStatus` and where reconciliation regenerates; `writeStatusRecord`
  (`:217-225`).
- `core/reducer.js` — how journal events reduce to the projection, so the new event applies
  cleanly and nothing else restores the id afterwards.
- `docs/design-spec.md` — wherever `--scrub-session-ids` is documented (grep `scrub`); the same
  commit must update it.
- `tests/core/commands/cleanup.test.js` (or wherever cleanup is tested).

## What to build

1. **Journal the scrub.** On a non-dry-run scrub of a terminal job, after (or instead of) the
   projection write, append an `attempt_state_changed` transition whose detail carries
   `backend_session_id: null` and `session_scrubbed_at: <iso>` (attempt = the record's
   `attempt_num`, `from`/`to` = the current state — the replay only consumes detail). The
   existing replay rule at `core/job-store.js:361` then yields `null` on every regeneration: the
   last write wins, which is already the journal's ordering semantics. Verify against the replay
   that a later `null` detail overrides an earlier id and that no other event can re-set it for a
   terminal job.
2. **Keep the projection write** as the fast path (readers that never regenerate still see the
   scrubbed value), or drop it in favour of regeneration — pick one and say why in the ticket
   Notes; the observable contract is: *any* public status read of a scrubbed job reports
   `backend_session_id: null`.
3. **Regression test.** Scrub a terminal job whose journal contains a session id, then force a
   regeneration (the public status path — e.g. `dcli status <id>` or the store's
   `regenerateStatus`) and assert `backend_session_id` is `null`. Also assert the raw journal
   still exists and is unchanged apart from the appended event.
4. **Docs.** Update the scrub description wherever it ships (cleanup reference; design-spec if it
   describes scrub semantics) to state that the scrub is durable (journal event) and applies to
   terminal jobs only.

## Non-goals

- **No rewriting or deleting journal entries.** The session id stays in the journal's history —
  the contract is that *derived* status never shows it again.
- **No change to scrub eligibility** (terminal jobs only — keep).
- **No new `status.json` field.**

## Acceptance criteria

- [ ] **A.** After `cleanup --scrub-session-ids`, every public status read (including one that
  forces regeneration from the journal) reports `backend_session_id: null`.
- [ ] **B.** The journal gains exactly one appended event per scrubbed job; no existing entry is
  modified or deleted.
- [ ] **C.** A non-terminal job is never scrubbed (unchanged behavior, covered by test).
- [ ] **Z.** `npm run check` green; the tracker table regenerated; docs updated in the same
  commit.

## Agent checks

```bash
# What this proves: the scrub is journaled, not just projected.
rg -n "session_scrubbed_at|backend_session_id: null" core/commands/cleanup.js
# expect: a journaled detail carrying both

# What this proves: no journal entry is ever rewritten or deleted.
rg -n "unlink|truncate|writeFileSync.*journal" core/job-store.js core/commands/cleanup.js
# expect: nothing touching journal files destructively (append only)

# What this proves: the fix is covered.
npm test -- --grep "scrub"   # expect: green, including the regenerate-after-scrub case
```

## Notes

(Left empty by the author. The implementer fills it in: what was changed and where, build and suite
results, the Agent checks' actual output, any deviation from this ticket and why, and anything
discovered that contradicts the docs.)
