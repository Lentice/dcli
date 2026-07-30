# 63 — OpenCode treats missing or malformed tool/session metadata as success

**What to build:** two places in the opencode adapter that default to "success" when metadata is missing or malformed instead flip to a neutral/unknown sentinel — a missing `part.state.metadata` does NOT make a `tool_result` `ok`, and a malformed session-status response does NOT get classified as `idle` (which the polling loop treats as authoritative turn completion). Both are instances of the "parse failure reads as clean result" trap (`AGENTS.md` §7).

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `adapters/opencode/adapter.js` `tool_result` fact emission (around line 540): `ok` is `null` (unknown) when `part.state.metadata` is absent, not `true`. The reducer can then choose not to count the tool call as successful; a downstream reader sees "tool attempted, outcome unknown" rather than "tool succeeded".
- [ ] `_fetchSessionStatus` (around line 1115-1144) returns `'unknown'` (or a new non-`idle` sentinel) for any response that doesn't positively look like a known status. The current `return 'idle';` fallback at ~line 1143 must NOT fire on malformed/empty/missing responses — only on a response that's *positively* an `idle` observation.
- [ ] The polling loop's `statusCache === 'idle'` → `IDLE_CONFIRM_MS` confirmation path (around line 1012-1021) does NOT promote to "turn complete" based on a single `unknown` or malformed poll; it continues polling (with an overall bounded budget) or eventually times out via `IDLE_TIMEOUT_MS` so the hard-timeout budget is the backstop.
- [ ] Test: a fake opencode stream emitting a `tool_use` event without `state.metadata` → the `tool_result` fact has `ok: null`, NOT `ok: true`.
- [ ] Test: a fake opencode session-status endpoint returning `{}` (or non-JSON) → `_fetchSessionStatus` returns `'unknown'`, the poll loop keeps polling, the attempt does NOT silently conclude as done.
- [ ] Test: a positive `idle` observation (e.g. `status[sid].type === 'idle'`) still concludes as today (preserve the working positive-idle path).
- [ ] Full suite green.

## Development guidance

- The poll loop's IDLE_CONFIRM confirmation specifically exists to avoid false positives on a single `idle` — but if the response is malformed, the current code produces `idle` BEFORE the confirm logic ever sees it, so the confirm check is firing on a fake `idle`. The fix is: don't fake the `idle` in the first place; return `unknown` and let the loop poll again.
- Don't add a new "malformed" sentinel that the polling loop special-cases — `unknown` is enough, it's the natural "no positive signal" value, and the existing timeout envelope handles the "we keep getting unknown" case.
- The contract for `tool_result.ok` should arguably become an enum `ok | failed | unknown` rather than a boolean — but that's an append-only contract change (Invariant #4); file as a follow-up if the consumer would benefit. For this ticket, just changing `true` default to `null` is enough.
- Coordinate with ticket 71 (reducer `cancel_requested_at` wins over completion) — both touch `core/reducer.js` rule ordering; sequence carefully.

## Why it matters

A backend that emits a malformed tool event (a build mismatch, a reconnect gap, a truncated stream) gets recorded as a successful tool call. The user's `read` shows a clean run when the tool actually crashed. The session-status fall-through to `idle` is the bigger failure: a single malformed poll concludes an attempt that may have hours of work left.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

## Commit message

```
fix(opencode): missing/malformed tool and session metadata is unknown, not success
```