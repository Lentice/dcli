# Ticket 83 — `--older-than <Nh>` is accepted by the parser and then always rejected

**Status:** done (2026-08-04)
**Tier:** small, but it is documented behaviour that cannot work, in three places at once.
**Blocked by:** none — can start immediately.

---

## Symptom

```
$ dcli cleanup --older-than 1h
--older-than "1h" is below the minimum of 1 day
```

Every hour value below 24 fails the same way. `12h` fails. The example in the error message that
teaches the format fails.

## Root cause

Validation is split across two layers that disagree:

- `parseArgs` accepts `/^\d+[dh]$/` with a minimum numeric value of 1, so `1h` is a valid invocation.
- `executeCleanup` then enforces a minimum age of one day, so no `h` value under 24 can ever pass.

The hour unit therefore exists in the surface syntax and nowhere in the semantics. Three documents teach
it: `--help` (`--older-than <Nd|Nh>`), `cleanup.js`'s own error strings (which offer `"12h"` as the
example), and the generated skills. Per AGENTS.md, ordering is always validate → convert → act; here two
validators exist and the outer one admits values the inner one is guaranteed to refuse.

## What to build

Pick one and make all four surfaces agree:

- **Support hours.** Lower the floor so `12h` means twelve hours. Retention is a user's judgement about
  their own disk, and a same-day floor is defensible for a tool whose jobs finish in minutes.
- **Or drop hours.** Reject `Nh` in `parseArgs` with a message that names days as the unit, and remove
  the unit from help, error strings, reference docs, and skills.

Supporting hours is the recommendation: the floor exists to stop a `0` from wiping every job (AGENTS.md
mistake #6), and a positive-integer check already does that job. Whichever is chosen, the reason belongs
in the ticket Notes — a floor with no recorded rationale is the thing that produced this split.

## Acceptance criteria

- [x] **A.** A single validation site decides what `--older-than` accepts. No value passes one layer and
  fails the next.
- [x] **B.** `--help`, the command's own error strings, `docs/reference/*`, and the generated skills all
  describe exactly the accepted units. No example in any of them is a value the tool rejects.
- [x] **C.** `--older-than 0`, `0d`, `0h`, a bare `--older-than` with no value, and a non-numeric value
  are each still rejected, with the failure's identity asserted — not merely that something threw.
- [x] **D.** `npm run check` green; docs regenerated and installed copies byte-match, in the same commit.

## Notes

- 2026-08-04: found while retiring a state root. `--older-than 1h` was the natural way to sweep jobs
  created earlier the same day, which is exactly the case the accepted-but-refused unit describes.
- 2026-08-04: chose to support hours. The positive-integer validation prevents `0` from sweeping every
  job, while allowing `1h`/`12h` makes same-day retention useful for jobs that finish in minutes.
- 2026-08-04: implemented one shared duration validator for argument parsing and cleanup execution;
  generated integration files were rebuilt from source.
