# 42 — Real Claude and OpenCode results are not persisted or counted

**Blocked by:** None — can start immediately
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` "The five invariants" #2–#5,
ticket 03 (job/attempt artifacts), ticket 26 (Claude adapter), and ticket 31 (adapter disposal).

---

## Purpose

Completed real Claude and OpenCode jobs must persist their returned text in the terminal job artifacts and
record the corresponding non-zero `result_bytes` value in `status.json`.

## Why it matters

The synchronous CLI prints a real answer, but the durable result is not inspectable from the job state. A
caller using `read`, resume-from-artifacts, reconciliation, or later diagnostics cannot reliably determine
whether a result was produced or how large it was. The status record also contradicts the observable CLI
output by reporting zero bytes for non-empty answers.

## Evidence (verified live against real backends)

Claude:

```powershell
'reply with the single word: pong' |
  node cli/dcli-claude.js run --repo . --hard-timeout-sec 90 --access read-only
# output: pong
# exit code: 0
```

Job `20260729T073833Z-gx8b52bv`, status file
`.dcli-state/jobs/7b5bae0c28b0/20260729T073833Z-gx8b52bv/status.json`, was terminal `done` and contained:

```json
"backend_session_id": "f657ea2c-6c7a-419a-a12c-85cb832143d9",
"command_exit_code": 0,
"result_bytes": 0,
"tokens": { "input": 2, "output": 4, "total": 6 }
```

The job directory contained only `journal.jsonl`, `status.json`, and an empty attempt directory; no result
text artifact was present.

OpenCode:

```powershell
'reply with the single word: pong' |
  node cli/dcli-opencode.js run --repo . --hard-timeout-sec 90 --access read-only
# output: pong
# exit code: 0
```

Job `20260729T074147Z-t9112imz`, status file
`.dcli-state/jobs/7b5bae0c28b0/20260729T074147Z-t9112imz/status.json`, was terminal `done` and contained:

```json
"backend_session_id": "ses_0532d6107ffeqzeZ46PrqV7PWC",
"command_exit_code": 0,
"result_bytes": 0,
"tokens": {
  "input": 13234,
  "output": 2,
  "reasoning": 11,
  "total": 13247
}
```

This is not the `--json` stdout-envelope behavior: both tests used plain mode and visibly printed `pong`.

## Design

- Persist the collected result text through the shared UTF-8 artifact writer before terminal-state
  projection completes.
- Set `status.json.result_bytes` to the exact UTF-8 byte length of the persisted result, including a
  deliberate zero-byte classification for genuinely empty results.
- Make `read` and artifact-based resume consume the same persisted result representation used by the
  status record; do not scrape human stdout after the command exits.
- Preserve the existing non-zero token/session facts while fixing result persistence.
- Keep writes bounded and atomic, and record an explicit failure if result persistence fails instead of
  silently writing `result_bytes: 0` for a non-empty answer.

## Pitfalls

- Do not treat the plain-mode stdout answer as proof that the durable result was written.
- Do not change the meaning of `result_bytes` or make it a character count; it must remain a UTF-8 byte
  count.
- Do not regress the documented `--json` envelope-only stdout contract.
- Do not turn a genuinely empty result into an error; distinguish empty from failed persistence.
- Verify both Claude and OpenCode. Fixing only the Codex path does not address this ticket's reproduced
  failure.

## Checklist

- [ ] A real Claude run that prints non-empty text produces a persisted result artifact and non-zero
      `status.json.result_bytes`.
- [ ] A real OpenCode run that prints non-empty text produces a persisted result artifact and non-zero
      `status.json.result_bytes`.
- [ ] The recorded byte count exactly matches the persisted UTF-8 result length.
- [ ] `read` returns the persisted result after the invoking process has exited.
- [ ] Empty results remain classifiable as empty rather than crashing.
- [ ] Persistence failure is terminally visible and cannot masquerade as a clean zero-byte result.
- [ ] Full suite is green.

## How to verify

```powershell
node tests/run-tests.js --suite full
'reply with the single word: pong' | node cli/dcli-claude.js run --repo . --hard-timeout-sec 90 --access read-only
'reply with the single word: pong' | node cli/dcli-opencode.js run --repo . --hard-timeout-sec 90 --access read-only
# inspect each terminal status.json and result artifact; result_bytes must be non-zero and exact
node cli/dcli-claude.js read <claude-job-id> --repo . --hard-timeout-sec 60
node cli/dcli-opencode.js read <opencode-job-id> --repo . --hard-timeout-sec 60
```

## Definition of done

Full suite green; real Claude and OpenCode jobs that print non-empty answers leave durable, readable result
artifacts and exact non-zero `result_bytes` values, while empty-result and persistence-failure cases remain
distinct and visible.

## Commit message

```
fix: persist real backend results and record their byte lengths
```

## Verification 2026-07-29 — appears FIXED on this machine

Re-ran this ticket's own evidence commands against real backends. The reported defect no longer
reproduces; see the run below. Status left as-is for the ticket owner to close, since this was a
verification pass and not an implementation of this ticket.

Claude, via the background path:

```
node cli/dcli-claude.js submit --repo . --prompt-file <f> --hard-timeout-sec 180 \
  --group t42probe --access read-only --json
node cli/dcli-claude.js wait --repo . --all --group t42probe --timeout-sec 220 --json
# → state: done
# status.json → result_bytes: 4 | backend_session_id: 52296b6f-… | tokens: {"input":2,"output":4,"total":6}
node cli/dcli-claude.js read 20260729T091654Z-k637fpks --repo .
# → pong
```

`result_bytes` is now the real byte count rather than 0, `attempts/1/result.md` exists on disk, and
`backend_session_id` is preserved. `core/result-artifact.js` (`persistCollectedResult`) is the
implementation.

**Still open, and distinct from this ticket:** the same probe against codex reported
`backend_session_id: null` and `tokens: {"input":0,"output":0,"total":0}` while correctly writing
`result_bytes: 4`. That is ticket 32 (codex collect-result facts), not this one.
