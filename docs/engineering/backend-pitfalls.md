# Backend protocol pitfalls

Read this before writing or changing an adapter. These are traps in the backends themselves, not in our
code — most were found by driving opencode live during the study, and each one has an obvious
implementation that is wrong.

Engine and process-lifecycle traps are in [`lessons.md`](lessons.md); this file is only about talking to
a backend. References to *study §n* are [`../reference/opencode-study.md`](../reference/opencode-study.md),
*spec §n* is [`../design-spec.md`](../design-spec.md).

## A silent hang is a distinct failure class, not a timeout

If a permission or question request is pending while the session reports `busy` and no event has arrived
within the watchdog window, that is `permission_or_sandbox` / blocked. Reporting it as `timeout` destroys
the diagnosis. This is the entire justification for ADR-002 — do not let it collapse back into a generic
timeout at implementation time.

## Never classify from a bare HTTP status code

Study §4: opencode reported **credit exhaustion as HTTP 401** with
`responseBody.error.type == "CreditsError"`. Classifying that as `auth` sends the operator to
re-authenticate a working login. Discriminate on the structured error type, follow the precedence ladder
in spec §8, and leave `failure_reason` null rather than guessing.

## `directory` / `workspace` routing is the largest correctness footgun

Every opencode HTTP endpoint takes optional `directory` and `workspace` query parameters. A missing
parameter on one endpoint can inspect or mutate **the wrong repository**. Establish one canonical job
directory, apply it to launch cwd *and* every request, and **verify the effective project identity
before sending the first prompt** (`GET /project/current`).

## Do not trust `/doc`, and do not trust `--help`

162 paths is not a contract. Depend on a small pinned subset; capability-probe at startup; reject
incompatible versions with a clear diagnostic; tolerate additive fields and unknown event types.
Separately: **never infer support from a flag appearing in `--help`** (spec §10) — the flag may exist and
not work, as study §8 shows for structured output.

## Event shapes lie in small ways

- **Top-level event `type` and `part.type` use different casing.** Study §4:
  `{"type":"step_start", ..., "part":{"type":"step-start"}}` — underscores at top level, hyphens inside,
  both in the same object. Do not normalize one and assume the other.
- **`step_finish` is not completion.** Only `reason == "stop"` on the **final** assistant message is. A
  tool-using turn emits `step_finish(reason="tool-calls")` mid-flight. Group by `messageID`; never
  blindly concatenate text across messages.
- **SSE is a progress channel, not the source of truth.** Reconnects, buffering, missed events and
  server termination are all possible. Declare completion only from a terminal session state, reconciled
  against `GET /session/status` and message retrieval — **never** from SSE closure alone.

## Structured output is a trap in opencode 1.18.7

Study §8: a `format: json_schema` request returned no parts **and permanently corrupted message
read-back for that session**. There is no safe in-session fallback. ADR-006: don't use it.

## One canonical permission ruleset per job, and never mutate user config

Study §7 verified that a wildcard `allow` overrides a config `ask`, but proved nothing about precedence,
ordering, patterns, or `deny`. Write contract tests before relying on fine-grained rules. Broad `allow`
is an explicit opt-in mode, never a default. Never write to the user's permanent opencode configuration.

## The long-lived server's own pipes must be drained too

Concurrent draining is usually specified for short-lived children, but the per-job `opencode serve`
process outlives them all. If its stdout/stderr is piped and not continuously drained, a verbose debug
dump fills the buffer and **hangs the server** — a never-hang violation inside the never-hang design.
Capture to a size-capped rotating job log and drain for the whole server lifetime.

## Per-job server hygiene

Random per-job password via environment (never on a command line, never in normal logs). Parse the bound
port from startup output, then confirm with `GET /global/health` — and note that **parsing a human
startup log is not a contract**: if no machine-readable handshake exists, reserving a port yourself
introduces a close-then-bind race, so bound the retries and *test the race*. Close every response body
and SSE connection. Bound concurrent active jobs. Record server metadata in
`<state-root>/servers/<job-id>.json` so a crashed wrapper's servers are still findable.

## `dcli-claude` recursion

Claude wrapping Claude requires the ADR-005 safeguards. Test that a worker cannot re-enter the delegating
skill, and that direct self-recursion fails fast with exit `2`.

## Do not let the native helper grow

The feature-creep path is predictable: "while we're here, let's also expose the process tree as JSON",
"let's add event-id-based kill verification". Each addition is ten lines and independently reasonable;
after five, the helper is a real native addon with its own multi-platform prebuild pipeline and the
project has two implementations. Banned in the helper: telemetry, path resolution, string manipulation,
business logic, process-tree introspection, timeout or cancellation-rung decisions, job state, backend
knowledge. Any expansion is a design-review item (ADR-008).

## Still unverified — check before you rely on any of these

1. `PermissionRuleset` precedence / ordering / pattern semantics and `deny` behavior.
2. Whether `--port 0` reliably reports the bound port, and on which stream (study §11.2).
3. Basic-auth mechanics on every endpoint used.
4. Whether SSE can miss events, and what reconciliation is sufficient.
5. Whether Claude Code's `-p` can block on permissions the way opencode does, and whether
   `--input-format stream-json` provides a control channel to answer them.

If your work depends on one of these, verify it and record the result in
[`../reference/opencode-study.md`](../reference/opencode-study.md) rather than assuming.
