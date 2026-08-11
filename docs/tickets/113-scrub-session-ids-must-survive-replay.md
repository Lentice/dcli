# 113 — `cleanup --scrub-session-ids` must survive journal replay

**Status:** done
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

- [x] **A.** After `cleanup --scrub-session-ids`, every public status read (including one that
  forces regeneration from the journal) reports `backend_session_id: null`.
- [x] **B.** The journal gains exactly one appended event per scrubbed job; no existing entry is
  modified or deleted.
- [x] **C.** A non-terminal job is never scrubbed (unchanged behavior, covered by test).
- [x] **Z.** `npm run check` green; the tracker table regenerated; docs updated in the same
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

**What changed and where.**

- `core/commands/cleanup.js:204-228` — the scrub branch now journals the scrub instead of
  mutating the projection in place: a non-dry-run scrub of a terminal job appends one
  `attempt_state_changed` transition whose detail carries `backend_session_id: null` and
  `session_scrubbed_at: <iso>` (attempt = `status.attempt`, from/to = `status.state`). The
  existing replay rule (`core/job-store.js:361`, `d.backend_session_id !== undefined`) turns the
  appended null into the durable value on every regeneration — last write wins, which is the
  journal's existing ordering semantics — and no other event can re-set the id for a terminal job
  (only live-attempt events carry it). The separate projection write is **dropped**: the ticket
  allowed keeping it as a fast path or dropping it in favour of regeneration; `journalTransition`
  already appends, regenerates, and rewrites `status.json` atomically in the same call, so a
  separate `writeStatusRecord` would be a redundant second write of the same derived value with
  no observable difference. `store.writeStatusRecord` itself is kept (ticket 96's public store
  API); its JSDoc no longer claims cleanup uses it.
- `tests/core/commands-tail-debug-cleanup.test.js` — three new tests: (16) scrub of a terminal
  job whose journal carries the session id appends exactly one `attempt_state_changed` event with
  `backend_session_id: null` + `session_scrubbed_at`, leaves every existing journal entry
  byte-identical, and `regenerateStatus` (the path that used to resurrect the id) reports null;
  (17) a non-terminal job is never scrubbed and its journal is untouched; (18) `--dry-run`
  appends nothing.
- Docs: `docs/reference/cli-{opencode,codex,claude}.md` cleanup sections now state the scrub is
  durable (journaled) and applies to terminal jobs only; `scripts/generate-integration.js`
  cleanup.md blurb updated and `integration/generated/commands/*/cleanup.md` regenerated.
  `docs/design-spec.md` does not describe scrub semantics (only the `backend_session_id` field),
  so no design-spec change was needed.

**Pre-existing flake found and fixed (test 15).** The existing scrub test
(`tests/core/commands-tail-debug-cleanup.test.js` test 15, "--scrub-session-ids blanks
backend_session_id") failed intermittently at HEAD (~1 in 3 runs on this machine): it hand-wrote
the session id into `status.json` only, and `listJobRecords`'s stale-projection judgement
(`journal mtime >= status mtime`) sometimes regenerated from the journal before the scrub read,
so the id was invisible and the scrub skipped — the injected rename fault then never fired and
the test asserted it had. Verified with `git stash` that the flake exists at HEAD, independent of
this ticket's changes. Fixed by journaling the id in the test setup as well as the projection, so
the record is identical either way. This is a test determinism fix, not a behavior change.

**Build and suite results.** `npm run check` green (exit 0): adapters 32, contract 2, core 58,
helpers 1, integration 3 = 96 passed, 0 failed; eslint clean. `node
tests/core/commands-tail-debug-cleanup.test.js` passes 5/5 consecutive runs.

**Agent checks (actual output).**

```text
$ rg -n "session_scrubbed_at|backend_session_id: null" core/commands/cleanup.js
209:          // detail carries backend_session_id: null. The projection alone is
221:              backend_session_id: null,
222:              session_scrubbed_at: new Date().toISOString(),

$ rg -n "unlink|truncate|writeFileSync.*journal" core/job-store.js core/commands/cleanup.js
(no matches — journal is append-only, never rewritten or deleted)

$ npm test -- --grep "scrub"
The repo's test runner has no --grep flag (discovered implementing ticket 111); the targeted
file was run directly instead:
$ node tests/core/commands-tail-debug-cleanup.test.js
All tail/debug/cleanup tests passed.   (includes the regenerate-after-scrub case)
```

**Deviations.** (1) The projection write was dropped rather than kept alongside the journal
event — see above for why. (2) Test 15's setup was made deterministic as described; no other
deviation.
