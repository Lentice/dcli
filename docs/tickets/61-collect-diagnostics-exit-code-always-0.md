# 61 — `CollectDiagnostics().exit_code` is always 0 in production across all three adapters

**What to build:** `doctor` and `debug` report the real backend exit code from the attempt's facts, not a hardcoded 0. Today `_mockExitCode !== null ? _mockExitCode : 0` returns 0 in production (where `_mockExitCode` is null), so a job that exited 130 (SIGINT), 137 (SIGKILL), or any non-zero is reported as a clean exit — making `doctor` and `debug` actively misleading for diagnosis.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `adapters/codex/adapter.js` `CollectDiagnostics` (around line 561-569) returns the real exit code: read it from the persisted `process_exited` fact (the adapter already keeps `_facts` or can look up the latest `process_exited` in `backend-events.jsonl`). Fall back to `null` when no `process_exited` fact was recorded (NOT `0`).
- [ ] `adapters/claude/adapter.js` `CollectDiagnostics` (around line 421-429) — same fix.
- [ ] `adapters/opencode/adapter.js` `CollectDiagnostics` (around line 1433-1444) — same fix.
- [ ] The fake adapter is unchanged (it already uses `_mockExitCode` for tests, which is the legit use of that field; the test path of the ternary is correct — keep it, just stop defaulting production to 0).
- [ ] `doctor` and `debug` consumers handle a `null` exit code without crashing — render it as `null`/`unknown` in the report, not as `0`.
- [ ] Test: a fake adapter Configured with exit code 137 → `CollectDiagnostics` returns `exit_code: 137`.
- [ ] Test: a fake adapter that never yielded `process_exited` (e.g. telemetry only) → `CollectDiagnostics` returns `exit_code: null` and `doctor`/`debug` render it without throwing.
- [ ] Full suite green.

## Development guidance

- The exit code lives in the `process_exited` fact's `code` field. The adapter accumulates facts during `Observe`; look up the LAST `process_exited` fact in the adapter's stored fact list (or `backend-events.jsonl` if the in-memory list was cleared) for the exit code.
- The fix is "do the lookup the production path was supposed to do" — the ternary is a copy-paste-from-test bug. If you can, refactor `CollectDiagnostics` to take the facts explicitly (the engine calls it from `worker.js`/`run.js` which already have `facts` in scope), so the adapter isn't reaching into its own mutable state. This is optional-but-cleaner.
- Coordinate with ticket 57 (`Recover`) — both want real exit code; ticket 57's "inspect durable evidence" naturally produces the exit code, and `CollectDiagnostics` can share the lookup helper if you build one.
- Do NOT default to `-1` or `1` for missing — null is honest. `0` is the worst default because it looks like success.

## Why it matters

`doctor` is the diagnosis tool the user reaches for when something failed. Reporting exit 0 for a killed job tells them "backend was fine" — the opposite of useful. The documented mistake `AGENTS.md` §7 is "A parse failure must never read as a clean result"; `exit_code: 0` for a non-zero exit is the same class.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

## Commit message

```
fix(adapters): CollectDiagnostics returns the real exit code, not a default 0
```