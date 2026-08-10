# 100 — opencode adapter: a transport seam replaces twenty-one `_testMode` branches

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

(Left empty by the author.)
