# 32 — Codex adapter's `CollectResult` must use the facts it already parsed

**Blocked by:** None — can start immediately
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` "The five invariants" #2
("Adapters emit facts; the engine decides state"), [adapter-contract.md](../adapter-contract.md).

---

## Purpose

`adapters/codex/adapter.js`'s real (non-test-mode) `CollectResult()` must aggregate token usage, cost, and
`backend_session_id` from the facts already parsed out of the codex `exec --json` event stream, instead of
hardcoding zeros and `null`.

## Why it matters

This is a correctness bug with a real downstream consequence, not just a cosmetic accounting gap:
**`resume --kind continue_backend_session` is completely broken for every real codex job**, because the
parent job's `backend_session_id` is always `null`.

## Evidence (verified live on this machine)

`_parseJsonlEvent` (adapter.js ~line 655) correctly recognizes `usage`/`tokens` events and `started`/
`session_start`/`thread.started` events, turning them into `usage_reported` and `started` facts. But
`CollectResult()`'s real-path branch (reading the `--output-last-message` file, ~lines 532–550) never reads
`this._facts` — it returns `usage: { input: 0, output: 0, total: 0 }` and `backend_session_id: null`
unconditionally.

Confirmed two ways:
1. A real `run` against codex (`echo "..." | dcli-codex run ...`) produced `status.json` with
   `tokens: {input:0,output:0,total:0}` and `result_bytes: 0` despite ~4 minutes of real work and a
   non-empty answer printed to stdout. Contrast: the same test against **opencode** correctly reported
   `tokens: {input:13077,output:3,...}` — proving the engine-side plumbing works and this is codex-specific.
2. `dcli-codex resume <job-id> --kind continue_backend_session ...` against a real completed codex job
   fails with `Parent job <id> has no backend session id to continue. Use --kind fork_from_artifacts or
   retry_attempt instead.` (exit 22) — for *every* codex job, because the field is never populated.

## Design

- In the real-path branch of `CollectResult()`, iterate `this._facts` the same way the `_testMode` branch
  already does: track the last `usage_reported` fact's tokens/cost, and the last `started`/`session_start`
  fact's `backend_session_id`.
- Keep reading `text` from the `--output-last-message` file (that mechanism is correct and unrelated) —
  only the `usage`/`cost`/`backend_session_id` fields need to come from facts instead of being hardcoded.
- This is the same shape of aggregation `adapters/opencode/adapter.js` and `adapters/claude/adapter.js`
  already do correctly in their real-path `CollectResult` — use them as the reference implementation.

## Pitfalls

- Do not assume every codex invocation actually emits `usage`/`session_start` events — some codex versions
  or flags may not. If no such fact was observed, fall back to `{input:0,output:0,total:0}`/`null`
  explicitly (that's a legitimate "backend didn't report it," distinct from "we didn't bother looking").
- Do not conflate this with ticket 35 (bounded stream drain) — that ticket is about *timing* (parsing
  before the stream fully closes); this ticket is about *using* facts that are already captured correctly
  today. Land them independently; they touch overlapping code so coordinate order if both are in flight.

## Checklist

- [ ] `CollectResult()`'s real-path branch aggregates `usage_reported` facts into `tokens`/`cost` instead
      of hardcoding zeros.
- [ ] `CollectResult()`'s real-path branch aggregates the last `started`/`session_start` fact's session id
      into `backend_session_id` instead of hardcoding `null`.
- [ ] A live or fixture-driven regression test asserts a completed codex job's `status.json` has non-zero
      `tokens` when the underlying process actually reported usage.
- [ ] A live or fixture-driven regression test asserts `resume --kind continue_backend_session` succeeds
      against a codex job that has a real `backend_session_id`.
- [ ] `docs/reference/cli-codex.md` and any adapter-contract notes are checked for claims that already
      assumed this worked, and corrected if they overstated current behavior.

## How to verify

```powershell
node tests/run-tests.js --suite full
echo "reply with the single word: pong" | node cli/dcli-codex.js run --repo . --hard-timeout-sec 60 --access read-only --json
# inspect the resulting status.json: tokens must be non-zero, backend_session_id must be populated if codex reported one
node cli/dcli-codex.js resume <job-id> --repo . --kind continue_backend_session --hard-timeout-sec 60 --access read-only
# must not fail with "no backend session id to continue"
```

## Definition of done

Full suite green; a real codex job reports non-zero tokens when the backend provides them, and
`continue_backend_session` resume works end-to-end against a real prior codex job.

## Commit message

```
fix: codex adapter aggregates usage and session id from parsed facts instead of hardcoding zero/null
```
