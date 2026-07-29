# 38 — `generate-integration.js --check` must actually compare generated output

**Blocked by:** None — can start immediately
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), ticket 24 (`--check` is the CI gate against doc rot),
`AGENTS.md` "Documentation maintenance".

---

## Purpose

`scripts/generate-integration.js --check` must regenerate into a temporary location and do a real,
complete comparison (file set and content hash) against `integration/generated/`, failing on any
difference — not merely check that selected files/substrings are present.

## Why it matters

Ticket 24 built the whole "generated docs must never go stale" invariant specifically because stale
integration docs are, per `AGENTS.md`, "the most expensive kind of doc rot in this project, because it is
invisible." A `--check` that computes hashes but never compares them provides exactly the false confidence
that invariant was meant to prevent: CI can be green while an agent is taught stale commands, flags, or
worker-prompt recipes.

## Evidence (verified via code read)

`scripts/generate-integration.js`: `sourceHashes` computed around line 172, `actualHashes` computed around
line 187, but no comparison between them — the function reports success unconditionally around line 250.
The check that does run only verifies selected files/substrings exist, not full-set exact-content parity.

## Design

- `--check` should: generate into a fresh temporary directory (the same generation logic used for real
  output, just pointed elsewhere), then recursively diff that directory against `integration/generated/`:
  - Same relative file set on both sides — flag any file present on one side and not the other.
  - SHA-256 match per file for every file present on both sides.
- Report every mismatch found (not just the first), so a drifted PR shows the full scope of staleness at
  once.
- Clean up the temporary directory in a `finally`, bounded — do not leave generation scratch directories
  behind on either success or failure.
- Exit non-zero (CI-failing) if any mismatch is found.

## Pitfalls

- Do not compare only a fixed known-file list — the whole point is catching *unexpected* drift, including a
  new file that should have been generated but wasn't, or an old one that should have been removed.
- Keep this fast enough to run on every CI invocation — generation itself should already be cheap; don't
  add anything unbounded.

## Checklist

- [ ] `--check` generates into a temp directory and performs an exact file-set comparison against
      `integration/generated/`.
- [ ] `--check` performs a SHA-256 content comparison for every file present in both trees.
- [ ] Every mismatch (missing, extra, or content-differing file) is reported, not just the first found.
- [ ] The temporary generation directory is removed afterward regardless of outcome.
- [ ] `--check` exits non-zero when any drift is found, zero when the trees match exactly.
- [ ] A regression test hand-edits one byte in a checked-in generated file (or deletes one) and asserts
      `--check` now fails, then reverts and asserts it passes again.

## How to verify

```powershell
node scripts/generate-integration.js --check     # must pass on a clean checkout
node tests/integration/generate.test.js
```

## Definition of done

Full suite green; a deliberately introduced one-byte drift in a checked-in generated file makes `--check`
fail, and reverting it makes `--check` pass again.

## Commit message

```
fix: generate-integration --check performs a real file-set and content-hash comparison
```
