# 12 — capabilities, doctor framework, option validation

**Blocked by:** 02, 10
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md) §5, `AGENTS.md` §6,
[ADR-004](../2026-07-28-architecture-decisions.md#adr-004).

---

## Purpose

A caller can ask what this backend can actually do, is told precisely when it asks for something the backend
cannot serve, and has one command that says whether the backend, the wrapper, or the environment is broken.

## Why it matters

This is the machinery that makes "one project, three backends" safe instead of confusing. The whole
anti-confusion strategy rests on two behaviors:

1. **Unsupported options hard-fail before any job exists**, naming the alternative. Never silently ignored,
   downgraded, emulated, or reinterpreted.
2. **Capabilities are declared, not guessed.** A flag appearing in `--help` proves nothing — opencode's
   structured-output field exists, is documented, and is *broken*.

## Design

### The capability manifest

Three layers combined into an **effective** result:

1. A checked-in static manifest per adapter — what the adapter intends to support.
2. Version compatibility data — which backend version ranges gate which features, including known-bad
   versions.
3. Runtime probes — executable presence, advertised facilities, endpoint shape checks.

```json
{ "schema_version": 1, "backend": "opencode", "backend_version": "1.18.7",
  "core": { "run": true, "submit": true, "resume": true, "cancel": true, "wrapper_worktree": true },
  "extensions": {
    "interactive_permissions":   { "supported": true,  "transport": "http" },
    "answerable_questions":      { "supported": true,  "transport": "http" },
    "graceful_session_abort":    { "supported": true },
    "native_worktree":           { "supported": true,  "stability": "experimental" },
    "schema_constrained_output": { "supported": false, "reason": "known broken in 1.18.7" } } }
```

The effective manifest is **snapshotted into every job at creation**, so a later backend upgrade cannot
retroactively change how an old job reads.

### Option rejection

```
dcli-opencode: --reasoning-effort is not supported by backend opencode.
Use --variant <provider-specific-value>.
Run 'dcli-opencode capabilities --json' for the current surface.
No job was created.
```

The `--json` form must distinguish two classes even though both exit `2`:

- `usage_error` — the syntax is wrong.
- `unsupported_capability` — the request is well-formed but this backend cannot serve it.

An agent reacts differently to those, so conflating them wastes a round trip.

### `doctor`

Common probes: state root writable and correctly ACL'd; native containment helper present and
version-compatible; git available; repository resolvable.

Per-backend probes (`--json` returns the envelope **even when checks fail**):

| Backend | Probes |
|---|---|
| opencode | executable resolves; version in range; per-job server starts and binds; `GET /global/health` returns healthy with a matching version; **a shape check on every endpoint the adapter depends on**, not merely reachability |
| codex | executable resolves to the **executable** form, not a `.ps1` shim; version in range; delegate to `codex doctor --json`; optional sandbox spawn-capability probe |
| claude | executable resolves; version in range; expected flags present in `--help`; auth reachable — **including whether `--bare` breaks auth on an OAuth-only host**. `claude doctor` has no `--json`, so the adapter builds the envelope itself |

Unsupported backend versions **fail closed** before job creation, naming the supported range. The failure
being prevented: a backend renames an endpoint, every call 404s, the classifier says `unknown`, and the user
concludes the wrapper is broken.

The live smoke is bounded (120 s default, overridable). A smoke timeout must be distinguishable from an
environment failure — the predecessor uses distinct exit codes for exactly this.

## Pitfalls

- Never infer support from `--help`. Static manifest is the source; the probe only confirms.
- Never mutate the user's backend configuration to make a capability work.
- `doctor --json` must still print its envelope on stdout when it fails — that is its whole value to an agent.
- Do not let a probe hang: every probe is individually bounded.

## Checklist

- [ ] `capabilities --json` emits the effective manifest combining static, version-gated, and probed layers.
- [ ] A test asserts support is never inferred from `--help` text.
- [ ] The effective manifest is snapshotted into every job at creation and never updated afterwards.
- [ ] An unsupported option is rejected **before any job is created**; a test asserts no job directory appears.
- [ ] The rejection message names backend, option, alternative, capabilities command, and that no job was created.
- [ ] `--json` failure output distinguishes `usage_error` from `unsupported_capability`.
- [ ] A test asserts no option is ever silently ignored, downgraded, or reinterpreted.
- [ ] Common doctor probes cover state root ACLs, containment helper compatibility, git, and repo resolution.
- [ ] Each per-backend probe set from the table is implemented (adapters may land with their own tickets, but
      the framework and the opencode/codex/claude probe slots exist).
- [ ] Unsupported versions fail closed before job creation, naming the supported range.
- [ ] `doctor --json` returns its envelope on stdout even when checks fail.
- [ ] The live smoke is bounded with an override; a smoke timeout is distinguishable from an environment failure.
- [ ] Every probe is individually bounded; a wedged probe cannot hang `doctor`.

## How to verify

```powershell
node tests/run-tests.js --suite full
node cli/dcli.js --backend fake capabilities --json
node cli/dcli.js --backend fake doctor --json
node cli/dcli.js --backend fake run --reasoning-effort high   # expect exit 2 + unsupported_capability
```

## Definition of done

Full suite green; a rejected option provably creates no job; `doctor --json` prints its envelope on failure.

## Commit message

```
feat: capability manifests, fail-closed version gating, and precise option rejection
```

## Notes

### Implementation summary

**New commands:**
- `capabilities --json` — calls `adapter.ProbeCapabilities()` and outputs the effective manifest.
- `doctor --json` — runs common probes (state root, git, repo resolution), per-backend diagnostics via
  `adapter.CollectDiagnostics()`, and returns the envelope even when probes fail. Each probe is individually
  bounded (10s timeout per probe).

**Option validation:**
- `--reasoning-effort`, `--variant`, `--effort`, `--live-smoke-timeout-sec` added as known flags to `parseArgs`.
- `ValidateRequest(request)` called before `store.createJob()` in both `run.js` and `submit.js`.
- The fake adapter rejects `--reasoning-effort` by default; other adapters declare their own `failValidateOn`.
- Rejection message format: names backend, option, alternative, `capabilities --json`, and "No job was created."

**Capability snapshot:**
- `run.js` and `submit.js` now capture `adapter.ProbeCapabilities()` and pass it as `capabilitiesSnapshot` to
  `store.createJob()`.

**Verification:**
```
node tests/run-tests.js --suite full   # 1 contract + 15 core = 16 passed
node cli/dcli.js --backend fake capabilities --json
node cli/dcli.js --backend fake doctor --json
node cli/dcli.js --backend fake run --reasoning-effort high   # exit 2 + unsupported_capability
```

**Documents updated:**
- `cli/dcli.js` — help text now lists `capabilities` and `doctor` commands plus new flags.
- `docs/2026-07-28-design-spec.md` — status header updated.

### Gaps closed in follow-up commit 4221628 audit

**GAP 1 — Version gating.** `core/commands/capabilities.js` was a passthrough with no version
compatibility check. Added: `DetectVersion()` output is checked against `supported_version_range` in the
capability manifest before job creation in both `run.js` and `submit.js`. Version helper functions
(`compareVersions`, `isVersionInRange`) are in `core/commands/index.js`. Out-of-range versions produce
`err.code = 'VERSION_OUT_OF_RANGE'`, `err.exitCode = 12`, and an error message naming the supported
range. Tests 9 and 10 in `tests/core/capabilities.test.js` verify rejection (no job directory) and
acceptance respectively.

**GAP 2 — Containment helper probe.** Added `probeContainmentHelper()` to `core/commands/doctor.js`,
reporting `isAvailable()` / `resolveHelperPath()` from `core/containment.js`. Included in
`runCommonProbes()`. Verified in doctor test 1 (probe presence and shape) and CLI output.

**GAP 3 — Live smoke.** `runLiveSmoke()` in `core/commands/doctor.js` calls `adapter.LiveSmoke()` with a
bounded timeout. On timeout the result has `status: 'timed_out'`; on environment failure it has
`status: 'failed'`. Tests 5 and 6 in `tests/core/doctor.test.js` prove both the presence of the live
smoke probe when `liveSmokeTimeoutSec` is provided and the distinguishability of timeout vs failure.

Also added `detectedVersion` to the fake adapter's configurable script defaults and an async
`LiveSmoke()` method with `behaviors.liveSmokeWaitMs` / `behaviors.liveSmokeFail` for test injection.

### Things that contradicted the docs

None. The design spec ADR-004, the ticket inline design, and the existing adapter contract all agreed.
The fake adapter's `ValidateRequest` initially only rejected when `behaviors.failValidateOn` was configured,
but the ticket's verification step expects `--reasoning-effort` to be rejected by default for the fake backend.
Adjusted: the fake adapter now rejects `reasoningEffort` unless explicitly listed in `behaviors.allowedOptions`.

### Per-backend probe completeness
Per the checklist: "the framework and the opencode/codex/claude probe slots exist." The framework in
`core/commands/doctor.js` calls `adapter.CollectDiagnostics()` for per-backend info. The actual
backend-specific probes (e.g. `opencode serve` startup, `codex doctor --json` delegation) are stubs
and will land with their respective adapter tickets.
