# 57 — `Recover()` always returns `done` in production regardless of the attempt's actual outcome

**What to build:** adapter `Recover()` consults durable evidence (the codex result file, the opencode attempt metadata, the claude session log / status.json) to infer an attempt's state after a controller crash — instead of unconditionally returning `{ state: 'done' }` whenever `_mockExitCode` is null. Today, a job whose process was hard-killed (SIGKILL by hard timeout, OOM, controller crash) is reported as a clean success on controller restart.

**Blocked by:** None — can start immediately (coordinate with ticket 55's reducer changes; both shape the terminal-state surface)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `adapters/codex/adapter.js` `Recover` (around line 593-599): inspect durable evidence — presence and content of the `-o` result file, the captured `_exitCode`/`_facts` if mid-stream when killed — and return `done` only when there's positive evidence the assistant completed (a non-empty result file plus a `process_exited {code: 0}` fact). Otherwise return `failed` (with `failure_reason`) or `interrupted`. Never `running` or `created` (contract rule).
- [ ] `adapters/claude/adapter.js` `Recover` (around line 444-448): same pattern — examine `_facts` / the persisted stream-json for an `end_turn` event or a final `result` message; return `done` only on positive evidence, `interrupted` on absence, `failed` on positive exit-nonzero.
- [ ] `adapters/opencode/adapter.js` `Recover` (around line 1464-1466): consult the per-attempt session metadata (server side or local cache) for an authoritative terminal status; `done` only on positive turn-completion evidence; `interrupted` if the metadata is silent or stale; never fall back to `done` by default.
- [ ] The contract (`docs/2026-07-28-design-spec.md` §8 Recover) requirement — "It MUST NEVER be `running` or `created`. … Inspects durable evidence" — is met by all three, and a unit test asserts `done` is NOT the default when no evidence is available.
- [ ] Test: a fake adapter with no recorded evidence returns `interrupted` from `Recover`, not `done`.
- [ ] Test: a fake adapter with a positive-completion fact returns `done`.
- [ ] Test: a fake adapter with a positive-failure fact returns `failed`.
- [ ] Full suite green.

## Development guidance

- The contract already requires this; the implementation just defaulted to `done` to satisfy the never-`running` rule in the least-effort way. The honest default when evidence is absent is `interrupted`, not `done` — `interrupted` says "this attempt did not reach a known terminal outcome," which is the truth.
- `core/commands/worker.js` already journals `interrupted` for the case its own process is killed; `Recover()` is the contract path that lets a restarted controller reach the same conclusion from the same evidence. Don't reimplement Recover's logic in `worker.js`; let `Recover` produce the verdict and `worker.js` consume it.
- The `fake` adapter should grow a `Recover()` that returns each of `done`/`failed`/`interrupted` based on a configured behavior, so the engine can be tested against all three branches.
- `CollectDiagnostics` (ticket 61) and `Recover` overlap: both want the real exit code. The fact set each adapter already accumulates in `Observe` (which gets persisted to `backend-events.jsonl`) is the durable evidence `Recover` should read. If `Observe` didn't persist enough (e.g. codex doesn't persist `_facts` until `worker.js` does it as `backend-events.jsonl`), that's a separate gap — file as an explicit follow-up rather than expanding this ticket.
- Do NOT add a `running`/`created` return — the contract forbids it, and `interrupted` covers the "I don't know" case honestly.

## Why it matters

When a worker is hard-killed and the controller restarts, every in-flight job is reported as a clean success — and downstream tools (`cleanup`, retention, agent readers) treat it as completed. A `done` from a `Recover()` that never checked anything is the "silent over-counting on failure" mistake (`AGENTS.md` §9 minor-rules: "A sweep counter incremented before a removal that failed reported work it had not done"), elevated to a terminal state.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

## Commit message

```
fix(adapters): Recover() infers terminal state from durable evidence, not a default done
```