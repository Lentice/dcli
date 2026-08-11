# 114 — the detached worker never initializes the writer-path redactor

**Status:** ready
**Blocked by:** —
**Tier:** The parent process initializes a `Redactor` that every durable write is supposed to pass
through; the detached worker is a fresh Node process that never gets one, so the documented
redaction guarantee does not hold on the submit path. Verified as a missing initialization path —
no claim is made about a particular secret reaching disk in a live run.
**Filed from:** 2026-08-11 dual-backend audit (codex F-6)

---

## Symptom / Goal

The parent CLI initializes the process-local redactor (`cli/dcli.js:153-154`:
`const redactor = new Redactor(); setRedactor(redactor);`). `core/fs-text.js` defaults its
module-level `_redactor` to `null` and writes unredacted content when unset (`core/fs-text.js:7,
:34, :55, :65`). The detached worker (`core/commands/worker.js`) imports `writeJsonFileAtomic`
from `../fs-text` (`:19`) but never imports or sets a `Redactor`. The opencode server registers
its generated per-job password through `getRedactor()` (`adapters/opencode/server.js:336-340`),
which is therefore `null` in the fresh worker process — the registration is a silent no-op and
anything that password protects (the job's `command.txt`, SSE URL, health token) is written
unredacted when the same content flows through a writer path.

## Root cause

Redactor state is process-local, and the detached worker is a fresh Node process that does not
receive the parent's initialization or registrations.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §5: "`backend_state` is the **only** place backend-specific data may live" —
unchanged; this ticket does not move where secrets live, it makes the existing writer-path
redaction actually active in the worker process.

`docs/design-spec.md` (grep `redact` for the exact redaction guarantee the docs make — the ticket
ships in the same commit as any doc fix that is false in the detached process).

## Files to read and trace first

- `core/fs-text.js` — `_redactor` default (`:7`), `setRedactor`/`getRedactor` (`:20-25`), the
  three write paths that redact when set (`:34, :55, :65`).
- `core/redactor.js` — `Redactor`'s constructor and `redactText`/`redactValue` (what the parent
  registers and how).
- `cli/dcli.js:107-108, 150-160` — the parent's initialization (the pattern the worker must
  mirror).
- `core/commands/worker.js` — `main()`'s start (`:25-45`), where the initialization must land
  before any write can occur (before `JobStore` construction / journaling).
- `adapters/opencode/server.js:336-340` — the `getRedactor()` registration call that is currently
  a no-op in the worker process.
- `tests/` — existing redactor tests (the parent-side pattern to mirror for the worker).

## What to build

1. **Initialize the redactor at the top of the worker's `main()`** (before the first `JobStore`
   construction or journal write): `const { Redactor } = require('../redactor'); const {
   setRedactor } = require('../fs-text'); setRedactor(new Redactor());` — mirroring
   `cli/dcli.js:153-154`. No secret content is known yet at that point (session ids arrive later
   via `getRedactor().register(...)`), so a bare constructor is the honest initialization; the
   point is that `_redactor` stops being `null` before any write path can run.
2. **Cover the registration flow.** The opencode server's `getRedactor()` call must now see the
   worker-initialized instance. Add a test proving the wiring end to end: run a worker-style
   process (or the actual worker with a fake adapter) where a known token is registered through
   `getRedactor()` and a writer path (e.g. `command.txt` or `result.md`) then receives that
   token — assert the written bytes are redacted. Plant the token explicitly in the test; do not
   depend on a real backend.
3. **Docs.** If any doc says "every write goes through the redactor" or similar, and the detached
   process contradicted it, the doc is now true — no doc change expected unless the audit's
   phrasing is quoted somewhere; grep and fix in the same commit only if a claim is false after
   this ticket.

## Non-goals

- **No redactor design change** — same class, same registrations, same write paths; only the
  worker's initialization is added.
- **No changes to how the parent registers secrets** (it registers as secrets are discovered;
  the worker registers the server password the same way once `getRedactor()` is non-null).
- **No scrubbing of already-written files** — the fix prevents future unredacted writes.

## Acceptance criteria

- [ ] **A.** A detached worker process has a non-null redactor before its first durable write;
  `getRedactor()` in the worker process returns the instance.
- [ ] **B.** A planted token registered via `getRedactor()` is redacted in a written file in the
  worker process (test).
- [ ] **C.** The parent path is unchanged (same `cli/dcli.js` initialization).
- [ ] **Z.** `npm run check` green; the tracker table regenerated.

## Agent checks

```bash
# What this proves: the worker initializes the redactor before any write.
rg -n "setRedactor|Redactor" core/commands/worker.js
# expect: import + setRedactor(new Redactor()) above the first store/journal write in main()

# What this proves: the worker-side wiring is covered by a planted-token test.
rg -n "planted|redact" tests/ --glob '*worker*'
# expect: the new test asserting written bytes are redacted

npm test -- --grep "redactor"   # expect: green
```

## Notes

(Left empty by the author. The implementer fills it in: what was changed and where, build and suite
results, the Agent checks' actual output, any deviation from this ticket and why, and anything
discovered that contradicts the docs.)
