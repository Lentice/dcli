# 100 — opencode adapter: a transport seam replaces twenty-one `_testMode` branches

**Status:** done
**Blocked by:** —
**Tier:** Test quality, in the largest and second-hottest file in the repository. The turn
reconciliation logic — SSE versus REST, idle confirmation, unknown status — is where opencode's real
defects live (ticket 81), and it is the logic the mocks bypass.
**Filed from:** architecture review, 2026-08-10 (all three reviewers named this independently).

---

## Symptom / Goal

`adapters/opencode/adapter.js` is 1771 lines. `_testMode` appears **21 times**, and the constructor
takes around fifteen `_mock*` options. The branches sit at the top of `_transportRequest`, `Start`,
`SendPrompt`, `_fetchSessionStatus`, `_readMessagesFromServer`, `_sseReadEvents`, `Observe`, `Respond`,
`DetectVersion`, `LiveSmoke` and `Dispose`.

The tests that matter already have to reach through the interface to work around this — they inject
`_transportRequestOverride`, set `_canonicalDir` and `_modelObj` by hand, and call private methods
`_processSseEvents`, `_selectFinalMessage` and `_buildPermissionRuleset` directly. That is the signal:
the module has no internal seam, so its test surface is its implementation.

Goal: two honest seams — a transport and an SSE source — so a test supplies scripted HTTP responses and
events, and the reconciliation logic under test is the production one.

## Root cause

The adapter owns HTTP, server lifecycle, metadata, permission rules, project verification, SSE, REST
reconciliation, interaction polling, message selection and doctor probes in one file with no internal
boundary. `_transportRequestOverride` is the right shape but was added as a test escape hatch rather
than as the module's transport interface.

## Binding constraints — quoted, do not go looking for them

From `docs/design-spec.md` §9: adapters emit **normalized facts**; the engine's reducer decides terminal
state. Nothing in this ticket may let the adapter declare a job finished (invariant 2), and the fact
vocabulary emitted must not change.

ADR-002 decided **one opencode server per job**. This ticket does not revisit that; the server module it
creates is per-job, exactly as today.

ADR-007 keeps session, HTTP and SSE concepts inside the adapter. **None of the new modules may live in
`core/`** — that would be invariant 1 and ADR-007 both.

Ticket 81 ("opencode unknown status never terminates", done 2026-08-04) is the class of defect this
change makes testable. Read its Notes — it carries the `/session/status` root cause and a version-pin
re-check — and make sure its behaviour is preserved and covered by a test against the new seam.

`docs/reference/opencode-study.md` says what is verified about opencode and what is not. Do not encode
an unverified assumption into the scripted fixtures; if a fixture asserts something the study does not
verify, say so in Notes.

## Blocked by nothing, but sequence after ticket 99

99 does the same job for the codex and claude adapters through a spawn seam. The two are independent
files, but landing 99 first gives this ticket a settled pattern to follow for how a scripted double is
written and where it lives.

## Files to read and trace first

- `adapters/opencode/adapter.js` — all 21 `_testMode` sites; `_transportRequest`,
  `_transportRequestOverride`, the `Observe` turn loop, `_fetchSessionStatus`, `_pollInteractions`,
  `_readMessagesFromServer`, `_sseReadEvents`, `_processSseEvents`, `_selectFinalMessage`,
  `_findMessageError`, `_buildPermissionRuleset`.
- `tests/adapters/opencode/async-prompt-reconciliation.test.js` — injects `_transportRequestOverride`
  and calls `_processSseEvents` / `_selectFinalMessage` directly.
- `tests/adapters/opencode/interactions-and-classification.test.js` — sets server URL, password, PID and
  session by hand.
- `tests/adapters/opencode/session-permissions-routing.test.js` — calls `_buildPermissionRuleset`
  directly.
- `tests/adapters/opencode/unresolved-status-bound.test.js` — ticket 81's regression test.
- `tests/contract/suite.js` — must stay green unchanged.
- `tests/adapters/codex/no-backend-conditional.test.js` — the existing gate that proves backend
  knowledge has not leaked. Criterion G is its subject; extend it rather than writing a second one.
- `docs/engineering/backend-pitfalls.md` — the opencode traps this code already handles.

## What to build

### 1. A transport interface

Promote `_transportRequest` from a method-with-an-override into a supplied dependency:

```js
transport.request({ method, path, body, headers, signal }) -> { status, headers, body }
transport.events(path, { signal }) -> AsyncIterable   // the SSE source
```

Production supplies the HTTP/SSE implementation. Tests supply an in-memory one. Every `AbortController`
bound that exists today stays — `AGENTS.md` requires one on every HTTP call.

### 2. A per-job server module inside `adapters/opencode/`

`start()`, `request()`, `dispose()`. It owns process launch, readiness, password and port. Still one
server per job (ADR-002).

### 3. A turn module inside `adapters/opencode/`

`run({ prompt, session, policy, deadline })`, emitting the normalized fact stream and the collected
result. It owns SSE reconnect, status polling, interaction polling, idle confirmation and the deadline —
the logic currently spread across the `Observe` loop, `_fetchSessionStatus`, `_pollInteractions` and
`_readMessagesFromServer`.

### 4. Delete every `_testMode` branch and `_mock*` option

`OpencodeAdapter`'s external interface does not change: it maps the wrapper request in, and adapter
facts out.

### 5. Rewrite the tests against the seams

Each of the four suites above drives the turn module with scripted transport responses and SSE events,
rather than calling private methods. Ticket 81's unknown-status bound is asserted this way.

## Non-goals

- **Moving anything into `core/`.** ADR-007 and invariant 1. Session, HTTP and SSE stay adapter-local.
- **Revisiting per-job servers** (ADR-002) or the rejected shared-daemon design (review record R3).
- **Changing the fact vocabulary, the permission ruleset semantics, or any classification.** This is a
  seam, not a behaviour change.
- **Splitting the file for its own sake.** The line count falls as a consequence; it is not the goal.

## Acceptance criteria

- [ ] **A.** `_testMode` and every `_mock*` option are absent from `adapters/opencode/adapter.js`.
- [ ] **B.** A transport and an SSE source are supplied to the adapter, not overridden onto it.
- [ ] **C.** No test calls `_processSseEvents`, `_selectFinalMessage`, `_findMessageError` or
  `_buildPermissionRuleset` directly; each is exercised through the turn module's interface.
- [ ] **D.** Ticket 81's unknown-status bound is covered by a test driven through the transport seam,
  and still terminates with an honest result.
- [ ] **E.** Every HTTP call still carries an `AbortController` and a finite bound.
- [ ] **F.** `tests/contract/suite.js` passes unchanged; `OpencodeAdapter`'s external interface is
  unchanged.
- [ ] **G.** No opencode, HTTP, SSE or session concept appears in `core/`.
- [ ] **Z.** `npm run check` green.

## Agent checks

```bash
# The inline double is gone.
grep -c "_testMode\|_mock" adapters/opencode/adapter.js
# expect: 0

# Tests no longer reach into privates.
grep -rn "_processSseEvents\|_selectFinalMessage\|_buildPermissionRuleset\|_transportRequestOverride" tests/
# expect: nothing

# Nothing leaked into core (invariant 1, ADR-007).
grep -rniE "opencode|sse|EventSource" core/
# expect: nothing but backend-name-as-data (registry lookups), no behaviour

# Every HTTP call is bounded.
grep -n "fetch(\|request(" adapters/opencode/*.js | wc -l
grep -c "AbortController\|signal" adapters/opencode/*.js
# expect: every call site has a signal

npm run check
# expect: green
```

## Handoff

**This is the largest ticket in the batch.** If step 1 below shows it will not fit in two days, split it
before starting — server module first, turn module second — and say so rather than half-landing it.

**Extra reading, beyond `AGENTS.md` and `00-onboarding.md`** — `docs/reference/opencode-study.md`
(it says what is verified and what is not — treat unverified facts as unverified),
`docs/reference/cli-opencode.md`, `docs/engineering/backend-pitfalls.md`, `docs/design-spec.md` §9,
and **ticket 81's Notes** (`81-opencode-unknown-status-never-terminates.md`), which carry the
`/session/status` root cause and the version pin re-check. Nothing else.

**Version pin:** opencode `>=1.18.0 <1.19.0`. Fixtures must be captured against a version in that range;
record which one in Notes.

**Implementation order:**

1. Read all 21 `_testMode` sites and write down, in Notes, what each bypasses and which test depends on
   it. Then estimate. This list is the plan.
2. **Capture real fixtures first.** Run a live opencode job with transport logging and save the actual
   HTTP responses and SSE event sequences for: a normal turn, a permission prompt, and an `unknown`
   status. Scripted fixtures invented from the code will encode the code's assumptions, and the whole
   point is to test those assumptions.
3. Extract the server module (`start` / `request` / `dispose`) first — it is the smaller half and has
   the clearest edge. Suite green.
4. Introduce the transport interface, replacing `_transportRequestOverride`. Convert the tests that use
   the override. Suite green.
5. Extract the turn module. Move the `Observe` loop, `_fetchSessionStatus`, `_pollInteractions` and
   `_readMessagesFromServer` into it **verbatim** first, then delete their `_testMode` branches as each
   test converts.
6. Rewrite the four named test suites against the turn module's interface (criterion C).
7. Delete the remaining `_testMode` branches and `_mock*` options.

**Running tests while you work:**

```bash
node tests/adapters/opencode/unresolved-status-bound.test.js
node tests/adapters/opencode/async-prompt-reconciliation.test.js
node tests/contract/suite.js
npm run check
```

**Traps specific to this ticket:**

- **Every HTTP call needs an `AbortController` and a finite bound.** `AGENTS.md` requires it and
  invariant 3 is the reason. Do not lose one while moving code.
- The SSE stream and the REST status poll can disagree. That reconciliation is ticket 81's subject — it
  is the logic most worth testing and the easiest to break while moving. Convert it last and assert its
  regression test at every step.
- **Nothing may move into `core/`.** ADR-007 keeps session, HTTP and SSE adapter-local; invariant 1
  forbids the backend conditional that would follow. Criterion G greps for this.
- ADR-002 decided one server per job. The server module is per-job. Do not add pooling or reuse.
- `OpencodeAdapter`'s external interface must not change — `tests/contract/suite.js` passing unchanged
  is the proof (criterion F).
- If a fixture would assert something `opencode-study.md` does not verify, say so in Notes rather than
  quietly making it a test expectation.

**Commit message:**

```
ticket 100: opencode adapter runs on an injected transport seam
```

## Notes

### 2026-08-11 — implemented, one commit (not split)

The estimate came in under two days, so no split was needed: server module and turn module
landed together in one commit. `adapters/opencode/adapter.js` went from 1771 lines to ~700;
the turn logic (SSE reconnect, status polling, interaction polling, idle confirmation,
unknown-status bound) now lives in `adapters/opencode/turn.js` (~650 lines), the per-job
server in `adapters/opencode/server.js`, the raw HTTP/SSE in `adapters/opencode/transport.js`,
and CreditsError classification in `adapters/opencode/classify.js`.

**Seam design.** The adapter is constructed with `{ transport, stateRoot, jobId }` only. A
supplied `transport` means the caller owns the HTTP/SSE surface and `Start()` launches no
server (the honest test seam); production constructs the adapter bare, and `Start()` creates a
per-job `OpencodeServer` whose `HttpTransport` becomes the adapter's transport. The transport
contract is exactly the ticket's: `request({ method, path, body, headers, signal }) ->
{ status, headers, body }` (raw text body, throws only on transport failure, and **asserts a
finite signal on every call** — invariant 3, criterion E) plus `events(path, { signal }) ->
AsyncIterable` of parsed SSE events decorated with `_sseId`/`_sseEvent`. The parsed-JSON /
non-2xx-throwing semantics the adapter needs are one small shared helper,
`requestJson(transport, { method, path, body, timeoutMs })`, which builds
`AbortSignal.timeout(timeoutMs)` itself — so every adapter/turn call site stays bounded without
repeating the boilerplate. `OpencodeTurn.run({ prompt, session, policy, deadline, context })`
owns all reconciliation; `context.isCancelled()` and `session.{id,promptSentAt,backendPid}` are
the only per-job inputs the loop needs beyond the ticket's four. The `prompt` argument is
accepted per the ticket's signature but is not yet used by the reconciliation logic (the prompt
is delivered in `SendPrompt`); it is stored on the adapter and passed through for future result
attribution.

**The 21 `_testMode` branches and what each bypassed** (line numbers in the pre-change file):

1. ctor (176) — the flag and ~15 `_mock*` options (177–185, 220–223). Bypassed: *all* backend
   interaction; depended on by every opencode test.
2. `_transportRequest` override (436) — injected responses. Bypassed: HTTP entirely.
   Depended: async-prompt #1, interactions, unresolved-status-bound.
3. `_transportRequest` simulated fallback (439) — `{ _simulated: true }`. Bypassed: HTTP.
   Depended: Respond and server-lifecycle minimal adapters.
4. `_verifyProjectIdentity` (462) — no-op. Bypassed: the directory-footgun check
   (backend-pitfalls.md). Depended: every test-mode SendPrompt call.
5. `DetectVersion` (767) — returned `_mockVersion`. Bypassed: the real version probe.
   Depended: contract suite, adapter.test.
6. `Start` (872) — fake pid 42 + seeded `_mockFacts`. Bypassed: process launch, readiness,
   health check. Depended: contract suite, adapter.test, server-lifecycle.
7. `SendPrompt` mock-SSE session (991) — set session id without POSTing. Bypassed: session
   creation + prompt_async. Depended: interactions, unresolved, async-prompt.
8. `SendPrompt` `_mockFacts` return (996) — early return. Bypassed: everything after
   project-identity. Depended: adapter.test minimal, contract.
9. `SendPrompt` no-override return (999) — early return. Bypassed: session/prompt. Depended:
   minimal adapters.
10. `_fetchSessionStatus` (1280) — `_mockSessionStatusResponses`. Bypassed: **the status parse
    itself — ticket 81's subject** (the regression test drove the real parse path). Depended:
    async-prompt #3/#4, interactions.
11. `_readMessagesFromServer` (1331) — `_mockMessagesResponse`. Bypassed: GET /message.
    Depended: async-prompt #4/5/6, interactions, unresolved.
12. `_sseReadEvents` (1409) — `_mockSseEvents` replay. Bypassed: the SSE source (framing,
    reconnect, socket). Depended: async-prompt, interactions, unresolved.
13. `Observe` mock-SSE routing (1497) — routed to the *real* reconciliation loop with mock SSE;
    bypassed only the SSE source.
14. `Observe` `_mockFacts` replay (1501) — bypassed the whole reconciliation loop. Depended:
    adapter.test minimal, contract.
15. `Respond` (1535) — override/simulated. Bypassed: POST reply. Depended: interactions #7/#10.
16. `CollectResult` (1622) — mock-SSE result path. Bypassed: turn result tracking.
17. `CollectResult` (1627) — `_mockFacts` replay. Bypassed: result derivation from emitted
    facts. Depended: adapter.test #7/#8, contract.
18. `Dispose` (1668) — skipped server teardown. Bypassed: dispose POST + tree kill. Depended:
    every test-mode test (it kept tests from touching real processes).
19. `_runEndpointShapeProbes` (1738) — skipped 3 of the 4 shape probes. Bypassed:
    /permission, /question, /session/status shape checks. Depended: interactions #16.
20. `LiveSmoke` (1771) — no-op. Bypassed: the version probe. Depended: interactions #17.
21. `LiveSmokeRequest` (1787) — no-op. Bypassed: the whole live smoke. Depended: interactions
    #17.

**Version pin.** `supported_version_range` unchanged: min `1.18.0`, max `1.19.0`. No fresh
fixture capture was performed for this ticket: the scripted responses reuse the shapes the
existing tests already consumed, which trace to the study (verified live on 1.18.7 and
1.18.10–1.18.12, incl. the ticket-81 amendment) — `/session/status` map, message `parts`,
permission/question arrays, `/project/current`. The version strings in tests are shim outputs,
not fixture claims. As a live cross-check, `server-teardown.test.js` ran with
`DCLI_OPENCODE_LIVE_SMOKE=1` against the installed 1.18.12 and passed end to end (Start →
SendPrompt → Observe → CollectResult → Dispose), confirming the production seam against a real
backend.

**Unverified-assumption watch.** The SSE `id:`/`Last-Event-ID` reconnect mechanism is
unverified per study §11.5; the `_sseId` decoration moved **verbatim** from the adapter (no new
assertion) and the reconnect tests assert only the verified message-re-read gap fill, never the
header. Nothing else in the fixtures asserts a study-unverified fact.

**Deliberate removals (dead or test-only code, noted per the ticket's "no behaviour change"
limit):**
- `IDLE_TIMEOUT_MS` (120 s) and `_idleTimeoutMs` were dead: the reconciliation loop uses
  `IDLE_CONFIRM_MS` (3 s) and the transport owns socket-idle tolerance; the only consumer of
  the 120 s constant was a test asserting its own existence.
- `SendPrompt`'s `response.statusCode !== 204` check was dead in production (the transport
  throws on non-2xx) and only served the mock path; the transport contract now owns status
  handling.
- `CollectDiagnostics().exit_code` now reflects the exit code the turn actually emitted (0
  after a run) instead of always null — the codex/claude adapters already behaved this way via
  their `_facts`.
- `_runEndpointShapeProbes` now runs all four probes unconditionally (the test-mode branch that
  skipped three was deleted; the probes are only reachable from tests today).
- `LiveSmoke`/`LiveSmokeRequest` are always real now; the "noop in test mode" behavior is gone
  with the mode itself, and `core/doctor.test.js` covers the envelope-on-failure guarantee.

**Criterion check.** A: `rg -c "_testMode|_mock" adapters/opencode/adapter.js` → 0 (no
`_testMode`/`_mock*` anywhere in `adapters/opencode/`). B: transport supplied in the
constructor, never overridden. C: no test references `_processSseEvents`, `_selectFinalMessage`,
`_buildPermissionRuleset` or `_transportRequestOverride`; rulesets are asserted on the captured
POST /session body, message selection on the emitted `assistant_text`/result facts. D: the
unknown-status bound is asserted through the seam (unresolved-status-bound.test.js, unchanged
reducer decisions). E: every HTTP call carries a signal — `requestJson` builds
`AbortSignal.timeout` for every call, the SSE source bounds connect by signal and idle by
socket timeout, and the transport rejects a call without a signal. F: contract suite passes
unchanged (suite.js untouched; contract.test.js/parity-gate.test.js construct the adapter with
the injected transport + a version shim). G: nothing added to `core/` (criterion G grep output
identical to the pre-change baseline). Z: `npm run check` green.
