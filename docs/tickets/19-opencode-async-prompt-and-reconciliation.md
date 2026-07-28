# 19 — opencode: prompt_async, event stream, status reconciliation

**Blocked by:** 18
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md) §6,
[ADR-002](../2026-07-28-architecture-decisions.md#adr-002) and its amendment,
[study §6](../2026-07-28-opencode-cli-study.md#6-opencode-serve--the-http-surface-observed).

---

## Purpose

Replace the synchronous message call from ticket 14 with the durable shape: submit asynchronously, follow the
event stream for progress, and derive truth from queryable state.

## Why it matters

A synchronous `POST /session/{id}/message` blocks for an entire model turn. That strands the wrapper on one
HTTP request, and when anything goes wrong — a permission, a provider stall, a wedged server — there is no
independent channel to observe it. That is the same trap as the CLI path, one layer up.

And the correctness rule that reviewers were emphatic about:

> **The event stream is a progress channel, not the source of truth.** Reconnects, buffering, missed events,
> and server termination are all possible. A permission can be created *and resolved* between polls. Derive
> correctness from **queryable durable state**; never from event receipt, and never from stream closure.

## Facts you need (verified / schema-confirmed)

| Endpoint | Contract |
|---|---|
| `POST /session/{id}/prompt_async` | body identical to `/message`; returns **204** |
| `GET /event`, `GET /global/event` | SSE event stream |
| `GET /session/status` | map of session id → `{type:'idle'}` \| `{type:'busy'}` \| `{type:'retry', attempt, message, next, action{reason, provider, title, message, label, link}}` |
| `GET /session/{id}/message` | full message list: `[{ info, parts }]` |
| `POST /session/{id}/abort` | graceful abort |

Message part types observed live: `step-start`, `reasoning`, `text`, `tool`, `step-finish`.
CLI stream equivalents used **underscores** at the envelope level (`step_start`) and **hyphens** inside
(`step-start`) — do not assume one casing.

`step-finish` carries `reason` (`"stop"` | `"tool-calls"`), `tokens{total,input,output,reasoning,cache{read,write}}`,
`cost`, and a `snapshot` hash. **`step-finish` alone is not completion** — only `reason: "stop"` on the final
assistant message is.

## Design

### The loop

```
1. POST /session/{id}/prompt_async                    (expect 204)
2. Connect GET /event; record the last event id if one is offered
3. Loop until the reducer says terminal:
     a. drain any events → emit facts
     b. every N seconds: GET /session/status  → emit backend_status
     c. every N seconds: poll pending interactions (ticket 20)
     d. on stream disconnect: reconnect with the last event id, then
        RE-READ GET /session/{id}/message to fill any gap
4. On idle: GET /session/{id}/message, select the final assistant message,
   concatenate its text parts, emit assistant_text + usage_reported
```

**Never** declare completion from stream closure. Never assume you saw every event.

### Selecting the result

Group parts by `messageID`. Take the **final completed assistant message**, not a concatenation across
messages — a tool-using turn produces several. Emit `usage_reported` from the final `step-finish`.

Bound the idle interval (120 s default): no event *and* no keepalive means investigate, not wait forever.

### Facts emitted

`started`, `assistant_text`, `reasoning` (presence only), `tool_invoked`, `tool_result`, `backend_status`,
`usage_reported`, `backend_error`, `stream_closed`, `process_exited`. Nothing else.

## Pitfalls

- Do not parse SSE by hand if the platform gives you a correct framing reader; if you must, handle multi-line
  `data:`, comments, and keepalives.
- Do not let a reconnect silently lose events — always re-read messages after reconnecting.
- Do not treat `retry` status as a failure. It is the provider backing off; surface it, keep the deadline running.
- A 204 from `prompt_async` means *accepted*, not *started*. Wait for evidence.
- Bound every HTTP call with an `AbortController`.
- Log unknown event and part types; never make them fatal (the schema is additive across versions).

## Checklist

- [ ] Prompts are submitted via `prompt_async`; a 204 is treated as accepted, not started.
- [ ] The event stream is consumed for progress and mapped onto closed-set facts.
- [ ] `GET /session/status` is polled on an interval and emitted as `backend_status`, including `retry`.
- [ ] Completion is **never** declared from stream closure; a test kills the stream mid-turn and proves the job
      still completes correctly via polling.
- [ ] On reconnect, the last event id is used where available **and** messages are re-read to fill gaps; a
      dropped-event test proves no fact is lost.
- [ ] The final result is selected by grouping on `messageID` and taking the final assistant message; a
      multi-message tool-using fixture proves no cross-message concatenation.
- [ ] `step-finish` with `reason: "tool-calls"` is **not** treated as completion; only `reason: "stop"` on the
      final assistant message is.
- [ ] Both underscore and hyphen casings are handled.
- [ ] Usage and cost are captured from the final `step-finish`.
- [ ] Idle timeout is bounded (120 s default) and distinguishes "no keepalive" from "still working".
- [ ] Unknown event and part types are logged and non-fatal.
- [ ] Every HTTP call carries an `AbortController` deadline.
- [ ] The contract suite still passes; the adapter still emits no fact outside the closed set.

## How to verify

```powershell
node tests/run-tests.js --suite full

# live: a tool-using turn, which exercises multi-message selection
node cli/dcli-opencode.js run --hard-timeout-sec 300 --model opencode-go/deepseek-v4-flash `
  "Run the bash command 'git rev-parse --abbrev-ref HEAD' and report only its output."
```

The result must be the branch name only — not the tool output concatenated with the assistant's prose.

## Definition of done

Full suite green including the killed-stream and dropped-event tests; a live tool-using turn returns the correct
final message.

## Commit message

```
feat(opencode): async prompting with event-stream progress and state-based reconciliation
```

## Notes
