# 20 — opencode: interactions, blocked classification, failure classes, doctor probes

**Blocked by:** 19
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md) §6,
[design spec §8](../2026-07-28-design-spec.md#8-failure-classification) including the interaction-outcome table.

---

## Purpose

A job that is waiting on a permission or a question is **detected and named as blocked**, not left to time out.
Failures are classified from structured evidence. `doctor` can tell whether opencode, the wrapper, or the
environment is at fault.

## Why it matters

This ticket is the payoff for choosing HTTP. On the CLI path an `ask` permission is indistinguishable from a slow
model turn, cannot be answered, and cannot be recovered. Here it is observable, nameable, and — where policy
allows — answerable.

Getting the *naming* right matters as much as detecting it. Reporting a blocked job as `timeout` destroys the
diagnosis: the user tunes a timeout instead of fixing a permission policy.

## Facts you need (schema-confirmed)

```
GET  /permission                     → PermissionRequest[]
     PermissionRequest = { id:'per_…', sessionID, permission, patterns[], metadata, always[],
                           tool{ messageID, callID } }
POST /permission/{requestID}/reply   body { reply: 'once'|'always'|'reject', message? } → bool
                                     404 → PermissionNotFoundError
GET  /question                       → QuestionRequest[]
     QuestionRequest = { id:'que_…', sessionID, questions[], tool }
POST /question/{requestID}/reply     body { answers: QuestionAnswer[] }
                                     "answers in order of questions, each an array of selected labels"
POST /question/{requestID}/reject
POST /session/{id}/permissions/{permissionID}   persistent per-session grant
```

Event component names include `EventPermissionAsked`, `EventPermissionReplied`, `EventQuestionAsked`,
`EventQuestionReplied`, `EventQuestionRejected`.

**Verified classification trap:** opencode reported credit exhaustion as HTTP **401** with
`responseBody.error.type === "CreditsError"` and `error.data.metadata.url`. Classifying that `401` as `auth`
would send the operator to re-authenticate a working login. The structured error type is the discriminator, not
the status code.

## Design

### Interaction handling

Poll `GET /permission` and `GET /question` **independently of the event stream** (an interaction can be created
and resolved between events). Map each to the shared outcome enum:

| Outcome | When |
|---|---|
| `pre_authorized` | the session ruleset already allowed it; nothing was asked |
| `denied_by_policy` | the ruleset refused it; the backend was told no |
| `awaiting_authorized_responder` | something must answer and an authorized responder exists |
| `rejected_unattended` | something must answer and nothing is authorized to |

**Default policy for an unattended job is `rejected_unattended`.** Being *able* to reply does not mean the
wrapper should invent an answer. Reply `reject` (with a message explaining why), then fail the job as
`permission_or_sandbox` / blocked — with the interaction's `permission` and `patterns` in the failure detail so
the user can fix their policy.

Answering is only permitted when an **explicitly supplied automation policy** authorizes that specific
interaction. Never a blanket "approve everything".

`Respond(interactionId, decision)` is implemented here and declared in capabilities.

### Blocked ≠ timeout

If an interaction is pending while status is `busy` and no progress event has arrived within the watchdog
window, classify **blocked**, not `timeout`. Exit `15`.

### Failure classification for this backend

Follow the precedence in design spec §8. Backend-specific inputs:

- Structured `error` events: `error.name`, `error.data.statusCode`, `error.data.responseBody` (parse it —
  `error.type` inside is the real discriminator), `error.data.isRetryable`, `error.data.metadata.url`.
- `GET /session/status` `retry` entries, including `action.reason` and `action.provider`.
- HTTP status **only in combination with** structured context.

**Bare status codes never classify alone.** A signature matching nothing leaves `failure_reason` null — that is
correct behavior, not a gap.

Redact provider bodies before persisting them (ticket 13).

### Doctor probes

Executable resolves; version in range; a probe server starts, binds, and authenticates; `GET /global/health`
returns healthy with a matching version; **a shape check on every endpoint the adapter depends on** — not mere
reachability, because a renamed field is exactly the silent-breakage case. Bounded live smoke, distinguishable
from an environment failure.

## Pitfalls

- Do not poll interactions only when an event suggests one. Poll on an interval, always.
- A 404 on reply means the interaction was already resolved — that is benign, not an error.
- Do not use `reply: 'always'` unless an explicit policy says so; it persists beyond this job.
- Do not classify `retry` as failure. It is the provider backing off.
- Do not let the interaction poll extend the job past its hard timeout.

## Checklist

- [ ] `GET /permission` and `GET /question` are polled on an interval, independent of the event stream.
- [ ] Every interaction is mapped to the shared four-value outcome enum.
- [ ] Unattended default is `rejected_unattended`: the interaction is rejected with an explanatory message and
      the job fails as blocked (exit `15`), with `permission` and `patterns` in the failure detail.
- [ ] Answering requires an explicitly supplied automation policy for that interaction; no blanket approval
      exists — a test asserts it cannot be configured.
- [ ] `Respond()` is implemented and declared in capabilities.
- [ ] A pending interaction while `busy` past the watchdog is classified **blocked**, never `timeout`; a live or
      fixture test proves the exact classification.
- [ ] A 404 on reply is treated as benign.
- [ ] `reply: 'always'` is never used without explicit policy.
- [ ] Classification follows the §8 precedence; a **regression test asserts HTTP 401 + `CreditsError` classifies
      as `quota_or_rate_limit`, not `auth`**.
- [ ] `retry` status is surfaced, not treated as failure.
- [ ] An unmatched signature leaves `failure_reason` null; a test asserts no guessing.
- [ ] Provider bodies are redacted before persistence (extend the planted-token test).
- [ ] Doctor probes include a **shape check** on every depended-upon endpoint, not just reachability.
- [ ] `doctor --json` returns its envelope even when opencode is broken or absent.
- [ ] The interaction poll cannot extend a job past its hard timeout.

## How to verify

```powershell
node tests/run-tests.js --suite full

# the decisive live check: reproduce the blocked case and confirm the naming
node cli/copencode.js run --hard-timeout-sec 180 --model opencode-go/deepseek-v4-flash `
  "Read the file <some path outside this repo> and tell me its contents."
node cli/copencode.js debug <job-id>
```

Expected: exit `15`, `failure_reason: permission_or_sandbox`, and `debug` naming the permission and patterns —
**not** a timeout.

## Definition of done

The blocked case is reported as blocked with actionable detail; the `CreditsError` regression test passes;
doctor shape-checks every endpoint the adapter uses.

## Commit message

```
feat(opencode): interaction handling, blocked classification, and endpoint-shape doctor probes
```

## Notes
