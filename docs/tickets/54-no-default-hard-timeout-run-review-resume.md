# 54 — `run`/`review`/`resume` have no enforceable hard timeout when `--hard-timeout-sec` is omitted or zero

**What to build:** the synchronous `run` path (which `review` reuses) and `resume` always apply a hard timeout — either the value the caller supplied or the documented default of 1800 seconds — and the parser rejects `0` as the "unbounded" escape it currently is. The help text `(default: 1800)` becomes truthful for the synchronous path the way it already is for `submit`/`worker`.

**Blocked by:** None — can start immediately (coordinate scope with ticket 55, which fixes the same `run.js` function)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `core/commands/index.js` `parseArgs` rejects `--hard-timeout-sec 0` with exit 2 (only positive integers are valid; negative already rejected). Zero means "unbounded" today and that's the documented worst-class failure (`AGENTS.md` §1, "unbounded wait cost a user eight hours").
- [ ] When `--hard-timeout-sec` is omitted, `run.js`, `resume.js`, and the `review` path that delegates to `executeRun` resolve an effective timeout from `resolveDeadline('JOB_HARD_TIMEOUT_MS')` (the same helper `worker.js:189` uses) **instead of** computing `hardTimeoutMs = 0`.
- [ ] The help text on `cli/dcli.js:30` is reconciled: either the code now genuinely defaults to 1800 (keep the text), or if 1800 is reserved for `submit` only, change the text to say "required for run/review/resume; default 1800 for submit".
- [ ] A test where `--hard-timeout-sec` is omitted but the adapter hangs returns within `~1800s` (use a fake adapter with `hangForever` scaled by an injected `DCLI_TEST_*` deadline override so the suite stays fast — `deadlines.js` already supports env overrides for tests).
- [ ] A test where `--hard-timeout-sec 0` exits 2 with a usage error.
- [ ] Full suite green.

## Development guidance

- The current broken pattern appears identically in `core/commands/run.js:138-162` and again in `core/commands/resume.js` (same shape — read it to confirm the exact lines). The fix is one helper used everywhere.
- `submit`/`worker.js:189` already does the right thing:
  ```js
  const hardTimeoutMs = parseInt(process.env.DCLI_WORKER_HARD_TIMEOUT_MS || '0', 10) || resolveDeadline('JOB_HARD_TIMEOUT_MS');
  ```
  Use the same `resolveDeadline` call in `run.js`/`resume.js`. The worker path accepts an explicit 0 from the env var because the env is only ever written by `submit`, which itself defaults to 1800 — the cli flag path has no such producer, so the cli flag must reject 0.
- Do NOT change `worker.js` — its 0-from-env path is correct (the env is filled by `submit.js` with an explicit nonzero value).
- The deadline race itself is covered by ticket 55: actual enforcement once the timer fires needs the observe `await` to be raced against the deadline. This ticket only ensures the timer is **set** when it should be; ticket 55 ensures it **fires and is honored**.
- Keep the existing behaviour that an explicit nonzero `--hard-timeout-sec` is used verbatim — including values above 1800 if the caller wants longer. The default only kicks in when the flag is absent, not as a cap.

## Why it matters

Omitting the flag on the synchronous `run` path silently removes the only thing that can kill a wedged backend. The help text advertises a default that doesn't apply on that path. This is Invariant #3 ("Nothing blocks forever") and the exact failure mode `AGENTS.md` spends the most words on — a stalled job consuming a whole working session.

## How to verify

```powershell
node tests/run-tests.js --suite full
```
And a live check: `dcli-claude run "sleep forever"` (omit `--hard-timeout-sec`) — before: hangs; after: returns exit 24 after ~1800s. Add a short test override so the suite doesn't actually wait 30 minutes.

## Commit message

```
fix(run/review/resume): apply the default hard timeout when the flag is omitted and reject 0 as unbounded
```