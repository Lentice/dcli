# 44 — Attempt directories are always empty for inline commands

**Blocked by:** None — can start immediately
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), section 4 ("Job state, in one picture").

---

## Purpose

Every job attempt directory (`attempts/<n>/`) must contain the durable artifacts defined in the
design spec: `prompt.md`, `command.json`, `result.md`, `backend-events.jsonl`, etc.

**Update (2026-07-29, re-review after ticket 42 landed):** `run.js` now writes `attempts/<n>/result.md`
and computes `result_bytes` via a `persistCollectedResult()` helper (added while fixing ticket 42). That
closes one file for one path only. Confirmed still open, live in the current tree:
- `run.js` still never writes `prompt.md` or `command.json` at attempt-creation time, nor
  `backend-events.jsonl` / `findings.json` at result time.
- `resume.js` writes nothing at all to the attempt directory (no `result.md` either).
- `worker.js` — the background/`submit` path — writes nothing at all to the attempt directory. This is
  still the most important gap: background jobs have no other visibility.
- `submit.js` still writes `prompt.txt`/`params.json` to the job root, not `attempts/1/`.
- `core/commands/tail.js:29` already reads `attempts/<n>/backend-events.jsonl` — nothing produces that
  file yet, so `tail` has nothing to show.

So this ticket remains valid and largely unaddressed; only narrow it to exclude `run.js`'s `result.md`/
`result_bytes`, which is done.

## Why it matters

The attempt directory is the only durable record of what happened during a job execution.
Without it:

- **A `debug` command has nothing to report** beyond the journal — no prompt text, no raw
  result, no backend events, no stderr logs.
- **Recovery after a crash has no artifacts to recover from** — the `RetryAttempt` resume kind
  has no prompt text to resend.
- **An external audit or manual inspection** of what was actually sent to the backend and what
  came back is impossible.
- **The design contract** (00-onboarding §4) promises these files exist; the gap silently breaks
  any consumer that depends on them.

The `submit` command *does* write `prompt.txt` and `params.json` to the job root directory
(not the attempt directory), but:
- `run` and `review` (inline execution paths) write nothing at all.
- `resume` writes nothing.
- `submit` writes to the wrong location (job root instead of `attempts/<n>/`).

## Evidence

```powershell
# Every run command — attempt directory is empty:
PS> Get-ChildItem .dcli-state/jobs/*/*/attempts/1 -Recurse
# (no output)

# Submit writes to job root, not attempts/1/:
PS> Get-ChildItem .dcli-state/jobs/*/*/prompt.txt
# exists
PS> Get-ChildItem .dcli-state/jobs/*/*/attempts/1/prompt.md
# does not exist
```

Verified for all backends and all job modes (run, submit, review, resume).

## Design

Three code paths create attempt directories: `run.js` (via `core/commands/run.js` line 95),
`resume.js`, and `worker.js` (line 115). All three should write the same set of
files immediately after the attempt directory is created, and again after the result is
collected. `run.js` already has the result-time `result.md` write (`persistCollectedResult()`,
added for ticket 42) — reuse/extend that helper for `backend-events.jsonl` and `findings.json`
rather than writing a second, divergent result-persistence path; and port the same helper (or a
shared one in `core/`) into `resume.js` and `worker.js`, which currently have no equivalent at all.

Write these files at **attempt creation time** (before the adapter starts):

| File | Content |
|---|---|
| `attempts/<n>/prompt.md` | The full prompt text sent to the backend |
| `attempts/<n>/command.json` | The command params: model, access, mode, hardTimeoutMs, reasoningEffort, variant, effort |

Write these files at **result time** (after `CollectResult` returns):

| File | Content |
|---|---|
| `attempts/<n>/result.md` | The `collected.text` from `CollectResult` |
| `attempts/<n>/backend-events.jsonl` | All facts emitted during the attempt, one JSON object per line |
| `attempts/<n>/findings.json` | The parsed findings result (for review jobs) — findings items, verdict, status |

Write these files **as the attempt runs** (streamed):

| File | Content |
|---|---|
| `attempts/<n>/stdout.log` | Backend process stdout (if captured) |
| `attempts/<n>/stderr.log` | Backend process stderr (if captured) |

Use the same atomic writer (`writeTextFileAtomic`/`writeJsonFileAtomic` from `core/fs-text.js`)
used elsewhere in the codebase.

Do NOT regress the `submit` path's existing `prompt.txt`/`params.json` at the job root until
those files are also written to the attempt directory — remove the job-root files only after
the attempt-dir files exist and all consumers are migrated.

## Pitfalls

- The attempt directory is created AFTER the job is created but BEFORE the adapter starts.
  Writing `prompt.md` and `command.json` must happen after the attempt dir exists (or be
  created alongside it). Currently `createAttemptDir` in `core/job-store.js` creates the
  directory — consider having it write the initial files, or have each command write them
  right after the `createAttemptDir` call.
- `backend-events.jsonl` is a stream — the adapter's `Observe()` method should write events
  to this file as they arrive. This conflicts with the current architecture where `Observe()`
  returns an async generator and the caller stores facts in memory. The simplest first fix is
  to dump all facts to the file after `Observe()` completes.
- Do not put large result text (e.g., a multi-MB review diff) into both `result.md` and
  `stdout.log` — pick one canonical location. The design spec uses `result.md` for the final
  result text.
- The `worker.js` path already has access to the job directory — this is the most important
  path to fix because background jobs produce invisible state.

## Checklist

- [ ] `run.js` writes `prompt.md` and `command.json` to the attempt directory before starting
      the adapter.
- [x] `run.js` writes `result.md` and computes byte length after `CollectResult` — done as part of
      ticket 42 (`persistCollectedResult()`).
- [ ] `run.js` additionally writes `backend-events.jsonl` and `findings.json` (if applicable) to
      the attempt directory after `CollectResult`.
- [ ] `resume.js` writes `prompt.md`, `command.json`, `result.md`, `backend-events.jsonl`, and
      `findings.json` (if applicable) for all three resume kinds — currently writes none of these.
- [ ] `worker.js` does the same (most important — background jobs have no other visibility;
      currently writes none of these).
- [ ] `submit.js` writes its `prompt.txt`/`params.json` to `attempts/1/` instead of (or in
      addition to) the job root, then stops writing to the job root after migration.
- [ ] Existing consumers that read job-root `prompt.txt`/`params.json` are updated to read
      from the attempt directory.
- [ ] Full suite green.

## How to verify

```powershell
echo "Say hello" | node cli/dcli-opencode.js run --repo . --hard-timeout-sec 60 --json
Get-ChildItem .dcli-state/jobs/*/*/attempts/1/ -Recurse
# Must show prompt.md, result.md, command.json, backend-events.jsonl
```

## Definition of done

Every `run`, `submit`, `resume`, and `review` command produces a non-empty attempt directory
with at minimum `prompt.md`, `command.json`, and `result.md`, and the `submit` path no longer
writes redundant files to the job root.

## Commit message

```
feat: populate attempt directories with prompt, result, command, and backend events
```
