# Architecture decision records

Date: 2026-07-28. Each ADR records the decision, the evidence, the rejected alternatives, and the
specific fact that would reverse it. Evidence references are to
[`reference/opencode-study.md`](reference/opencode-study.md) (cited as *study §n*).

---

## ADR-001 — One project, three adapters, three shims, three generated skills

**Status:** accepted.

**Decision.** Build a single repository containing one shared job engine and three backend
adapters (Codex CLI, opencode CLI, Claude Code CLI). Ship three shim commands — `dcli-codex`,
`dcli-opencode`, `dcli-claude` — plus an umbrella `dcli --backend <b>` for scripting. Generate three
separate Claude skills from one documentation source.

**Why one project.** The expensive, failure-prone machinery is genuinely backend-independent:
state-root discovery, job-directory allocation, job ids / groups / labels / lineage, atomic
`status.json` writes and schema migration, lifecycle phases, locking with PID-reuse-safe process
identity, detached workers and startup sentinels, hard deadlines, cancellation escalation, Windows
process containment, UTF-8 artifact handling, git-worktree isolation with snapshot/diff/apply, and
the `status`/`wait`/`read`/`list`/`tail`/`debug`/`cleanup`/`doctor` command family. Implementing
that three times guarantees drift in exactly the contracts that callers depend on. One maintainer
cannot afford three copies.

**Why NOT one skill.** "One skill" was the operator's stated upside, but it is the wrong target.
A Claude agent loads a skill *by name*, so three focused skills cost the agent nothing — they cost
only the maintainer, and generating them from shared source removes that cost. A single flat skill
documenting a surface where some flags work only on some backends is precisely the shape that makes
an agent infer symmetry and compose an invalid call.

> The goal is **one maintained source of truth producing backend-specific skills**, not one skill.

**Rejected: three repositories.** Does not remove blast radius — it converts a visible shared-refactor
risk into invisible divergence plus triplicated fixes.

**Rejected: a lowest-common-denominator uniform surface.** See ADR-004.

**Reverse this if** any of ADR-001-R1..R8 in §"Kill criteria" below is observed.

---

## ADR-002 — opencode backend: one wrapper-owned `opencode serve` process **per job**, driven over HTTP

**Status:** accepted. **This reverses an earlier CLI-first recommendation.**

**Decision.** For each `dcli-opencode` job, launch a dedicated
`opencode serve --port 0 --hostname 127.0.0.1` process, drive it over HTTP, and dispose of it when
the job reaches a terminal state. Do **not** use `opencode run --format json` as the production path.

**Why.** Study §5: headless `opencode run` **hangs forever, silently, with zero stdout**, when any
permission resolves to `ask`. On the CLI path that state is indistinguishable from a slow model
turn, cannot be answered, and cannot be recovered — the only mitigation is the process-global
`--auto`, which opencode's own help labels `(dangerous!)`. A wrapper whose headline promise is
"never hangs" cannot be built on that.

The HTTP surface (study §6) buys, all verified or schema-confirmed:

- **Per-session permission rulesets** (study §7, verified to defeat the §5 hang) — scoped per job,
  no global `--auto`, and `deny` expressible.
- `GET /permission` + `POST /permission/{id}/reply` — detect and resolve a prompt instead of hanging.
- `GET /question` + reply/reject — the stuck-on-a-clarifying-question failure mode becomes handleable.
- `GET /session/status` → `idle | busy | retry{...}` — a real progress signal to drive watchdogs,
  distinct from "process still alive".
- `POST /session/{id}/abort` — graceful cancellation *before* any hard kill.
- `GET /event` SSE — progress.
- `GET /session/{id}/diff`, `/vcs/diff`, `/vcs/apply` — change inspection without parsing incidental output.

**This is not a daemon.** Lifetime, isolation, logs, and process-tree kill remain per job, exactly
as with a CLI invocation. Process count is unchanged: `opencode run` itself takes `--port` and
starts a local server internally. The shared-failure-domain objection to an HTTP backend applies to
a *long-lived shared* server, which this is not.

**Costs accepted, with required mitigations:**

| Cost | Mitigation |
|---|---|
| ~2 s server startup per job | Immaterial against tens-of-seconds model turns. Measure under concurrency. |
| `--port 0` behavior unverified (study §11.2) | Parse the listening address from startup output, then confirm with `GET /global/health`. If unreliable, reserve a loopback port and retry bind races. |
| Loopback is still locally reachable | Random per-job password via `OPENCODE_SERVER_PASSWORD` in the environment — never on a command line, never in normal logs. Authenticate every request. |
| `directory`/`workspace` routing is the biggest footgun | Establish ONE canonical job directory; apply it consistently to launch cwd, `--dir`, and every query parameter; then **verify the effective project identity before prompting**. A missing parameter on one endpoint could mutate the wrong repository. |
| `/doc` is not a stable contract (162 paths) | Depend on a deliberately small endpoint subset. At startup: check `/global/health` + version, capability-probe the required endpoints, reject incompatible versions with a clear diagnostic, tolerate additive fields/events. Use `/doc` for compatibility detection and test fixtures, not runtime trust. |
| Server survives wrapper death | Process containment (ADR-003), not API cancellation. |

**Prompt execution shape.** Do **not** use synchronous `POST /session/{id}/message` as the primary
primitive — it may block for an entire model turn and strands the wrapper on one HTTP request when
things go wrong. Instead:

1. Create the session with an explicit permission ruleset.
2. Connect SSE.
3. Submit via `POST /session/{id}/prompt_async`.
4. Reconcile from SSE **plus** periodic `GET /session/status`.
5. Poll `GET /permission` and `GET /question` independently.
6. Declare completion only from a terminal session state/event — **never** from SSE closure alone.

SSE is a progress channel, not the source of truth: reconnects, missed events, buffering, and
server termination must all be survivable via status/message reconciliation.

**Permission policy is a wrapper decision, not an API one.** Being *able* to reply does not mean an
unattended wrapper should invent answers. Default: apply an explicit per-session policy; **reject**
unexpected permission requests and fail with a precise blocked status; detect questions and either
answer from explicitly supplied automation policy or reject promptly. Never wait indefinitely for
interactive input in a background job.

**No CLI fallback.** A second full backend would duplicate lifecycle, event parsing, permission,
cancellation, testing, and failure-classification logic while silently degrading the most important
guarantee. If the HTTP surface is incompatible, fail during capability negotiation and name the
supported opencode versions. A small `doctor`-only diagnostic that shells out to `opencode run` is
acceptable; it must never be an automatic production fallback.

**Reverse this if** per-session permission rulesets turn out not to be honored reliably (study
§11.1), or if the HTTP surface proves unstable enough across opencode versions that pinning becomes
untenable while the CLI stream stays stable.

---

## ADR-003 — Implementation language: plain Node.js + a minimal native process-containment helper

**Status:** accepted.

**Decision.** Implement the wrapper in **plain JavaScript on Node.js** (no build step), plus one
small **prebuilt native helper** whose only job is Windows Job Object process containment. Ship
per-adapter code in whatever language suits the adapter behind the boundary; do not force
opencode's long-lived HTTP/SSE work into PowerShell for repository uniformity.

**Ratings under the ADR-002 architecture:**

| Option | Rating | Assessment |
|---|---:|---|
| **Node.js, plain JS** | **9/10** | Best fit for HTTP + SSE + NDJSON + timers + schema validation, which is now the dominant workload. Directly readable and patchable with no toolchain. |
| Go | 8/10 | Strongest containment and single-binary distribution, but every local patch needs a Go toolchain and rebuild — which conflicts with a stated operator preference, not merely aesthetics. |
| TypeScript compiled with Bun | 7.5/10 | Good ergonomics, but combines a build step with Bun-specific behavior and still doesn't deliver Go's mature Windows process control. A Bun regression would hit opencode and its wrapper simultaneously. |
| PowerShell 7 | 4.5/10 | Native to the existing `ccodex`, but long-lived SSE, concurrent polling, cancellation, stream framing, and robust async lifecycle are substantially harder to make dependable. Acceptable for the Codex/Claude adapters; a poor fit for opencode. |

**The reasoning that changed.** An earlier assessment rated Go 9/10 with decisive factor #1 being
"guaranteed process-tree termination on Windows" via Job Objects — a genuine Node weakness. Under
ADR-002, cancellation becomes primarily an **API** operation
(`/session/{id}/abort` → `/global/dispose` → hard kill only as last resort), and the work is
dominated by HTTP/SSE/JSON. Job Objects stop being the central execution mechanism and become
**catastrophic-failure containment**.

**But containment is still required.** Graceful API cancellation only works while the wrapper is
alive and the server responds. It cannot cover: wrapper crash or SIGKILL, machine shutdown mid-cleanup,
a wedged server event loop, a dead HTTP listener, a provider subprocess ignoring cancellation, or
descendants that detach.

**Why `taskkill /T /F` is not sufficient for that worst case:**

- Enumeration races with newly spawned descendants.
- A child can exit after spawning a process that was not in the snapshot.
- Detached or reparented descendants evade tree discovery.
- **Wrapper death prevents the wrapper from invoking `taskkill` at all.**
- PID reuse complicates delayed cleanup unless creation time and image identity are both checked.

Repeated enumeration until a verified quiescent state helps, but cannot provide a kernel-enforced
kill-on-close guarantee.

**The native helper's scope is deliberately tiny.** It must contain no HTTP, session, permission,
repository, or business logic:

1. Create the `opencode serve` process suspended (or otherwise before it can spawn descendants).
2. Assign it to a Job Object configured `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, breakaway disallowed.
3. Resume it.
4. Report the child pid and any startup failure.
5. Keep the containment handle alive such that wrapper death closes it.
6. Perform bounded hard termination on request.

This is preferable to a Go "sidecar" holding meaningful runner behavior — once protocol logic leaks
into the sidecar, the project has two implementations and two debugging surfaces.

**Recovering TypeScript's safety without a build step:** JSDoc annotations with `checkJs` during
development, checked-in JSON schemas or explicit validators at every protocol boundary, strict
handling of unknown event variants, `AbortController` deadlines on every HTTP operation, and one
explicit state machine rather than promise choreography spread across commands.

**Reverse this if** chaos testing shows the helper cannot reliably contain every opencode descendant,
or shipping a prebuilt native artifact is unacceptable — then choose **pure Go** and put the whole
wrapper under one Job-Object-aware binary. Conversely, if testing proves opencode never leaves
descendants after hard termination and verified repeated `taskkill` is reliable across wrapper
crashes, **drop the helper** and ship plain Node alone.

---

## ADR-004 — Share outcome-level contracts only where the wrapper can enforce them; otherwise namespace by backend

**Status:** accepted. This is the rule that makes ADR-001 safe.

**The distinction that matters.** *Feature* differences are harmless — a backend either has an
operation or it does not, and capabilities declare which. *Semantic* differences are dangerous —
the same-looking option promising different behavior on different backends.

**Safe (feature differences, expose as capabilities or namespaced commands):** opencode can answer
permission requests; opencode has native worktree and VCS endpoints; Claude can define inline
agents (`--agents <json>`) and resume from a PR (`--from-pr`); Codex has `--output-last-message`.

**Dangerous (semantic differences — do NOT unify the flag):**

| Concern | Codex | opencode | Claude | Ruling |
|---|---|---|---|---|
| Reasoning effort | `--effort none..ultra` (enum) | `--variant <provider string>` (unbounded) | `--effort low..max` (enum) | **Never** put `--variant` behind `--effort`. Use backend-qualified names. |
| Isolation / access | process-level sandbox flag | per-session permission ruleset | permission mode + tool allow/deny patterns | A shared `--access read-only` is acceptable **only** if the wrapper defines and *verifies* a wrapper-level invariant ("the worker cannot modify the target checkout"). Not acceptable as a pass-through of vaguely similar native settings. |
| Approval "ask" | cannot be answered in this execution model | suspends, answerable over HTTP | noninteractive behavior unestablished | A shared `--approval ask` would be actively misleading. |
| Resume | thread id | server session | session resume **or** fork | Common concept "continue this completed wrapper job"; adapters enforce backend-specific preconditions (availability, mutability, concurrent-continuation safety). |
| Cancellation | kill process tree | session abort → dispose → kill | kill tree / native agent stop | Share the **outcome** ("the job ceases running within bounded escalation"); record the mechanism separately. |
| Background execution | wrapper-owned | `prompt_async` | native `--bg` + `claude agents` | Different ownership models; affects status authority, containment, cleanup, crash recovery. See ADR-005. |
| Structured output | NDJSON event stream | present but broken (study §8) | `--output-format json` | Separate two capabilities: "machine-readable wrapper envelope" vs "model constrained to a schema". No generic `--json-output`. |
| Worktree / diff | wrapper-managed only | native experimental endpoints exist | wrapper-managed only | Wrapper-managed worktrees are the shared contract; native endpoints are a namespaced extension. |

**Emulation for the sake of symmetry is forbidden.** Concretely banned: translating opencode
`variant=high` into a generic effort level; claiming runtime permission handling on Codex by
restarting with broader access; presenting wrapper-side JSON extraction as native
schema-constrained generation; mapping Claude native agents onto ordinary wrapper jobs without
exposing the ownership difference; treating a killed process as equivalent to a clean session abort.
Each hides exactly the fact an agent needs to reason safely.

Wrapper-level implementation *is* appropriate when it creates a real, enforceable common invariant.
Wrapper-managed git worktrees are the model case: the same isolated-checkout and snapshot contract
regardless of native support. That is a separate wrapper facility, not a pretence of parity.

**Unsupported options must hard-fail with exit `2`, before any job is reserved:**

```
dcli-opencode: --effort is not supported by backend opencode.
Use --variant <provider-specific-value>.
Run 'dcli-opencode capabilities --json' for the current surface.
```

The message must name the backend, the rejected option, the supported alternative if one exists,
the capabilities command, and that no job was created. Never silently ignore, downgrade, or
reinterpret.

---

## ADR-005 — `dcli-claude` bypasses Claude's native `--bg` / `claude agents` by default

**Status:** accepted.

**Decision.** `dcli-claude` launches an ordinary child `claude -p` process and the wrapper owns
detachment, status, timeout, containment, logs, and cleanup. Native background agents are offered
later, if at all, as an explicitly namespaced extension (`dcli-claude native-agent ...`) — never as the
implementation of ordinary `dcli-claude submit`.

**Why.** Claude Code is the only one of the three backends with its own job manager. Two
overlapping job managers create ambiguous authority over status, result retrieval, process
containment, and crash recovery.

**Recursion safeguards are mandatory** (Claude wrapping Claude is sound only with them):

- Stamp the child environment with a recursion sentinel (e.g. `DCLI_WORKER=1`).
- The installed skill/rule must forbid `dcli-claude` delegation from inside a `dcli-claude` worker unless
  explicitly requested and depth-bounded.
- Use a stripped/controlled settings environment (`--bare`, explicit `--settings`).
- Avoid installing the delegating skill into the worker context where practical.
- Record the parent wrapper job and the native Claude session id separately.
- Detect direct self-recursion early and fail with exit `2`.

---

## ADR-006 — Native opencode structured output is not used

**Status:** accepted. **Evidence:** study §8.

Request plain text; perform wrapper-side extraction and schema validation of the findings appendix.
Retain the raw response when validation fails. Do **not** attempt an in-session fallback to text —
the observed failure leaves the session permanently unreadable via `GET /session/{id}/message`.

Revisit when a tested opencode version fixes it, and only behind a capability flag
(`schema_constrained_output.supported`).

---

## ADR-007 — The adapter contract is fact-based; the engine owns the terminal-state reducer

**Status:** accepted 2026-07-28, after adversarial review by both Codex and opencode
(see [review record](architecture-review-record.md) findings 1–3).

**The problem it fixes.** Both reviewers independently identified the same top risk: building the
shared engine together with the opencode adapter would make HTTP/session concepts the de facto
adapter interface — server readiness, SSE reconciliation, permission queues, HTTP abort, "terminal
session state". Codex and Claude Code are supervised CLI processes with stream protocols and a
different notion of completion. The outcome would be fake sessions in the CLI adapters, or a parallel
sync path in the engine that violates ADR-001's no-backend-conditionals invariant.

**Decision.**

1. **Adapters emit normalized *facts*, not session events.** `observe()` yields facts such as
   "assistant text produced", "tool invoked", "interaction pending", "usage reported", "process
   exited", "backend reports idle". Never "SSE message received".
2. **The engine owns a terminal-state reducer.** Process exit, API session state, and parsed output
   are all *evidence* fed to one engine-owned reducer. There is no universal "terminal session state"
   criterion: for CLI adapters, process exit plus validated result and completed drain may be
   terminal; for opencode, a terminal session state is one input among several.
3. **Optional operations are declared by capability, not assumed.**
   `respond(interactionId, decision)` exists only where the backend supports it.
4. **`requestCancel()`, `dispose()`, and `recover()` have explicit postconditions**, stated per
   adapter and tested by the contract suite.
5. **Cancellation rungs are declared by the adapter.** The engine walks whatever ladder the adapter
   declares and records which rung was reached. A hardcoded four-rung sequence in the engine is
   itself a backend-conditional in disguise — Codex has exactly one rung (hard kill), opencode has
   abort → dispose → kill, Claude with native agents bypassed has one.
6. **Interaction *outcome* is a shared contract even though interaction *mechanics* are not.** Every
   interaction resolves to exactly one of:

   ```
   pre_authorized | denied_by_policy | awaiting_authorized_responder | rejected_unattended
   ```

   Policy syntax stays backend-native (ADR-004). This outcome enum is unified because without it
   `blocked` and "unattended execution" would mean different things per backend — and that is
   precisely the class of shared contract the wrapper *can* enforce.

**Build-order consequence.** Define the adapter contract **before implementing any adapter**, then
build thin vertical slices for opencode **and Codex together**, using Codex as the standing
counterexample while designing every interface. Deferring Codex's *production migration* is sensible;
deferring its *adapter proof* is not. Claude stays last.

The argument that previously justified deferring Codex — "`ccodex` works today, porting risks a live
regression" — was shown to be a non-argument: `dcli` is a separate repository, so a Codex
adapter here does not touch the production `ccodex` command. There is no regression risk to trade
against.

**Reverse this if** the fact vocabulary cannot express some backend's behavior without a
backend-specific fact type. That would mean the abstraction is wrong, not that the rule should bend.

---

## ADR-008 — Fail-closed guardian: controller death terminates the job

**Status:** accepted 2026-07-28. **Evidence:** review record finding 4.

**The problem.** ADR-003's helper keeps a Job Object handle alive so that wrapper death lets the
kernel kill the tree. But Node cannot reconstruct a lost Job Object handle after a crash. So either
running jobs are non-resumable after controller death, or the helper must accept authenticated
reattachment — with durable identity, liveness leases, reconnect semantics, status queries,
cancellation, and version negotiation. That second option *is* a process supervisor, and it recreates
exactly the two-implementation problem ADR-003 exists to avoid.

**Decision: the fail-closed guardian.**

- The helper is tied to the invoking controller. **Controller death always kills the job.**
- Recovery marks the affected attempt `interrupted`.
- `resume` starts a **new attempt** from durable inputs — it never reattaches to a running backend.
- This is a stated **non-promise**: *dcli does not promise continuation of running jobs
  across wrapper crashes.* Say it in the user documentation, not just here.

**Keeping it from rotting into two implementations:**

- **Node remains the sole state machine.** The helper exposes only versioned primitives —
  `spawn-contained`, `terminate`, lifecycle notifications.
- The helper **never** decides timeouts, cancellation rungs, job state, or backend behavior.
- Explicitly banned in the helper: telemetry, path resolution, string manipulation, business logic,
  process-tree introspection, and any backend knowledge. Any expansion is a design-review item, not a
  ten-line convenience.
- Binaries ship per architecture with hashes and a compatibility handshake, and **fail closed** when
  containment is requested but the helper is missing or incompatible.
- `taskkill` is an explicitly **degraded** capability recorded in the job record — never a transparent
  fallback.

**Ownership proof.** pid + creation time + image path reduces PID-reuse mistakes but does not *prove*
ownership. The helper generates a random execution token per job; the wrapper stores it and verifies
it before acting. OS identity is corroboration only.

---

## ADR-009 — Naming contract: the `dcli` family, permanently distinct from the predecessor

**Status:** accepted 2026-07-28, after a dedicated review by the Codex CLI and an availability search.

**Decision.** The family name is **`dcli`**. Every identifier below is a **locked contract** — not a label —
because each is persisted, parsed, discovered by path, or copied into project configuration.

| Item | Value |
|---|---|
| repository / package | `dcli` |
| umbrella command | `dcli` (`dcli --backend <b> …`, `dcli backends --json`) |
| shim commands | `dcli-codex`, `dcli-opencode`, `dcli-claude` |
| state root | `%LOCALAPPDATA%\dcli\` · `~/Library/Application Support/dcli/` · `${XDG_STATE_HOME}/dcli/` |
| project policy | `.dcli/policy.json`, top-level key `delegation` |
| installed skills | `~/.claude/skills/{dcli-codex,dcli-opencode,dcli-claude,dcli}/SKILL.md` |
| installed commands | `~/.claude/commands/{dcli-codex,dcli-opencode,dcli-claude}/*.md` |
| installed rule | `~/.claude/rules/dcli-delegation.md` |
| findings marker | `<!-- dcli:findings -->` |
| environment prefix | `DCLI_` |
| `status.json.backend` values | `codex` · `opencode` · `claude` |

### Why not reuse `ccodex` / `copencode` / `cclaude`

There is an existing, working, installed production tool named **`ccodex`** — this project's predecessor —
with its own command on `PATH`, its own state root, its own installed skill, commands, rule, `status.json`
schema, exit codes, and `<!-- ccodex:findings -->` marker. It keeps running unchanged while `dcli` is built
(the Codex adapter is one of the last tickets), so **both exist for a long period**.

The decisive failure mode, and the reason a temporary alias is not enough:

> Skill installation and `PATH` resolution select **independently**. An agent can read one generation's
> `ccodex` skill while executing the other generation's binary. The invocation still *looks* valid, so the
> result is silent contract drift — wrong flags, wrong status interpretation, wrong findings parsing, wrong
> recursion behavior — rather than a clear "command not found".

A loud collision would be recoverable. This one is invisible. So the new family takes permanently distinct
names, the predecessor is left completely untouched, and the two can be compared side by side while rollback
is still trivial.

The property that mattered about short shim names is preserved: the **backend-bearing suffix** is the visible
type tag, not the `c` prefix. `dcli-codex` says which adapter is being invoked just as clearly, and adds
provenance.

**Rejected: renaming the predecessor.** That spends the stability of a working production tool to reserve an
attractive six-character name, and creates compatibility work without reducing any design risk.

**Rejected: `dgate` / `delegate`.** `delegate` is far too generic for a globally installed executable. `dgate`
was the reviewer's recommendation, but an availability search found an existing npm package `dgate` (a domain
gateway) that **ships a `dgate` binary** — adopting it would inflict the exact silent-`PATH`-collision failure
this ADR exists to prevent, on someone else. `dcli` is free on npm and on `PATH`; `dcodex` is *not* free on
npm, which is why the shims are hyphenated rather than `dcodex`/`dopencode`/`dclaude`.

### Installer ownership — a consequence of this ADR

The installer must **hard-refuse to overwrite any target it cannot positively identify as its own**, applied
independently to shim paths, skill directories, command directories, rule files, and the state root.

Ownership is established by an **installation manifest** carrying a stable product id, schema version, and
installed-file hashes. *"The directory already has the expected name" is not proof of ownership.* There is an
explicit uninstall/migration operation; there is **no** generic force-overwrite flag that bypasses the
foreign-ownership check.

### Marker coexistence

Producers emit **only** `<!-- dcli:findings -->`. Consumers may recognize the predecessor's
`<!-- ccodex:findings -->` during coexistence, but a document containing both is **ambiguous and rejected** —
never silently resolved by taking the last one. The marker is **not versioned**; the schema version lives
inside the JSON object (`schema_version`), so parsers dispatch on one stable delimiter instead of an expanding
set.

### `backend` values are opaque IDs

`codex` / `opencode` / `claude` are adapter identifiers **owned by this project**, not vendor or product
display names. Do not qualify them (`openai-codex`) — that falsely implies vendor identity participates in
routing and still does not survive a rename. If richer identity is ever needed, **add fields**
(`backend_display_name`, `backend_implementation`); never change the enum.

### Environment variables

One prefix, `DCLI_`, with three declared classes:

- **Runtime:** `DCLI_WORKER`, `DCLI_DEPTH`, `DCLI_STATE_ROOT`, `DCLI_BACKEND`, `DCLI_JOB_ID`.
- **Test-only:** `DCLI_TEST_*`. Prefer explicit injection through arguments or harness configuration; every
  environment knob is a process-global hidden input. **A test-only variable must never become an undocumented
  production override merely because production code happens to read it** — declare the class and enforce it.
- **Not ours to name:** the per-job backend server secret is passed as `OPENCODE_SERVER_PASSWORD` because
  opencode requires that exact name. It is generated per job, held in memory only long enough to build the
  child environment, never mirrored into a `DCLI_*` variable, and redacted from every captured environment and
  diagnostic dump.

### What is allowed to change later

Only the human-facing labels: help text, backend display names, repository description. Everything in the
table above is persisted, parsed, or discovered by path, and is therefore already a contract. **Never reuse a
stable identifier for a new meaning, even if the old meaning appears obsolete.**

---

## ADR-010 — Termination is a declared capability ladder, not a guarantee

**Status:** accepted 2026-08-10. **Supersedes** the all-or-nothing framing of §14's 2026-08-02 amendment
and of ticket 78. Does **not** supersede ADR-003, ADR-007 or ADR-008 — the Job Object remains the top rung,
the adapter still declares the cancel rungs, and the guardian model is unchanged.

**The problem.** Ticket 78 posed containment as one binary choice: wire the native Job Object helper, or
have nothing. It was closed unimplemented because the helper discards stdin data while codex and claude
deliver the prompt on the child's stdin. The decision to close was correct on its evidence. Its *shape* was
not: a single closed ticket became the repository's only record of a standing architectural position, so the
question is re-opened by every architecture review that reads the code. It was re-proposed on 2026-08-10 by
one of three independent reviewers, which is the evidence that a closed ticket cannot carry this weight.

Meanwhile the framing hid two cheaper mechanisms behind the expensive one:

- **Unix process groups are unimplemented and unblocked.** §14 already specifies them. The adapters spawn the
  backend without `detached: true` and terminate it with `child.kill('SIGKILL')`, which reaches the direct
  child only. `detached: true` plus `process.kill(-pgid)` is a real guarantee on that platform, and the
  native helper has nothing to do with it.
- **Verified descendant enumeration plus `taskkill /T /F` is already sanctioned** by §14 as the Windows
  fallback when Job Object assignment fails. Ticket 78's line "a pid-based tree kill is not an alternative"
  is a narrower claim than it reads: it is about the *helper's* `terminate` command, which acts solely on the
  Job Object that helper instance created. It is not an argument against dcli performing its own walk.

**Decision.** Termination is a ladder. Each platform occupies a declared rung; the rung is recorded in the
job record; a rung is climbed only when its mechanism exists and is tested.

| Rung | Mechanism | Guarantee | Record |
|---|---|---|---|
| 0 — none | direct-child `SIGKILL` only | none for descendants | `kill_skipped: 'not_contained'` |
| 1 — process group (Unix) | `detached: true`, `SIGTERM` → grace → `SIGKILL` to the group | the group dies | `containment.kind: 'process-group'`, `degraded: false` |
| 2 — degraded tree kill (Windows) | verified descendant enumeration + `taskkill /T /F`, against the exact enumerated pid set | best effort, survivors named | `containment: { kind: 'taskkill-tree', degraded: true }`, survivors in `containment_survivors`, exit `21` on survivors — never a clean `cancelled` |
| 3 — Job Object (Windows) | ADR-003's helper, kill-on-close | the tree dies, including on controller death | `containment.kind: 'job-object'`, `degraded: false` |

Rung 3 stays the target. Rungs 1 and 2 are not consolation prizes: rung 1 is a full guarantee on its
platform, and rung 2 buys most of the *outcome* of rung 3 at a fraction of the cost, while being honest that
it does not buy the *proof*.

**The line that does not move.** A rung may never report a kill it did not achieve. Rung 2 in particular
introduces a mechanism that *could* claim success it cannot verify — a descendant spawned between
enumeration and termination escapes, and pid reuse is reduced by `pid + creation time + image path` but never
disproved (ADR-008). So rung 2 must verify against its own enumerated set and report the survivors, ending in
exit 21 with a named survivor set rather than a clean cancellation. Reporting uncertainty is always
preferable to reporting a kill. This is the rule §14's 2026-08-02 amendment established — `kill_skipped:
'not_contained'` and `cancel_rung_reached: 'containment_unavailable'` exist precisely so rung 0 never lies —
and it is the only reason the current rung-0 state is defensible at all.

**Why this order.** Rung 1 costs one spawn option and one signal call, and §18 makes cross-platform a
requirement rather than a hypothetical. Rung 2 is bounded work in the wrapper with no native protocol
involved. Rung 3 requires designing stdin forwarding and a bounded EOF drain into the helper's protocol —
a native-code project whose entire payoff is a proof on one platform. Climbing from the bottom delivers most
of the value long before that cost is paid, and each rung is independently shippable and independently
honest.

**Consequences.**

- User documentation states the non-guarantee where the budgets are described, not only in the spec.
- Proposing containment work means proposing a specific rung with its evidence, not re-opening "should we
  have containment".
- **Rung 3 is reopened only on evidence**: rung 2 shipped, and observed survivors in practice that rung 2
  could not reach. Absent that evidence, ticket 78's closure stands and this ADR is the answer to anyone who
  proposes reversing it.

---

## Amendments

### ADR-002 amendment (2026-07-28)

- **Port discovery must be a machine-readable handshake.** Parsing human startup logs is not a
  contract. If opencode offers no bound-port handshake, reserving a port introduces a close-then-bind
  race that must be accepted and *tested* with bounded retries. This gates the opencode adapter.
- **SSE correctness derives from queryable durable state**, never from event receipt. A permission can
  be created and resolved between polls; events can be missed on reconnect. Persist the last event id
  where supported; reconcile from queryable resources.
- **Server stdout/stderr is captured and drained for the whole server lifetime**, to a size-capped
  rotating job log. An undrained pipe on a long-lived verbose server hangs it — a never-hang violation
  inside the never-hang design.
- **Engine-level admission control** bounds global and per-backend concurrency. Fan-out multiplies
  model runtimes, file watchers, caches, provider connections, and memory — not merely process count.

### ADR-003 second amendment (2026-07-28) — experiment results

The containment experiment (ticket 06, step 1) confirms all four questions positively:

1. **Can opencode serve be created suspended, assigned to a Job Object with
   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and breakaway disallowed, then resumed?**
   **YES.** The native helper (`contain.exe`) successfully creates any Windows process
   (including `opencode serve`) with `CREATE_SUSPENDED`, assigns it to the Job Object
   before it runs any code, then resumes it. Verified: `CreateJobObjectW` +
   `SetInformationJobObject` (kill-on-close, breakaway disallowed) + `AssignProcessToJobObject` +
   `ResumeThread` works correctly for both test fixtures and opencode 1.18.8.

2. **Do its grandchildren end up inside the job?**
   **YES.** A test fixture that spawns a child process inside the job is killed when
   the Job Object is terminated. opencode serve's children (watchers, providers) are
   observed inside the job. No process escapes containment.

3. **When the handle-holding process is killed, does the kernel kill the tree?**
   **YES.** When the helper process is killed with `SIGKILL` (no cleanup opportunity),
   the kernel's kill-on-close mechanism terminates all contained processes. Verified
   for both test processes and opencode serve. No survivor detected.

4. **Does opencode ever create a process with `CREATE_BREAKAWAY_FROM_JOB`?**
   **No observed breakaway.** When the helper was killed, opencode and all its
   descendants died. No process survived outside the job on this host (opencode
   1.18.8, Windows 11 10.0.26200). If future opencode versions introduce breakaway,
   containment must be re-verified.

**Consequence:** ADR-003's language decision (plain Node.js + a minimal native helper)
stands. The alternative of pure Go is not required. The helper binaries ship per
architecture with hashes; the fail-closed guard prevents use when the helper is missing.

Superseded in part by **ADR-008**, which resolves the helper's ownership model. The language choice
(plain Node.js + a minimal native helper) stands; the helper's *protocol* is now explicitly
fail-closed and versioned rather than merely "small".

### ADR-004 amendment (2026-07-28)

- **Worktree isolation is repository-state isolation only.** It prevents mutation of the user's
  checkout. It does **not** prevent the backend reading credentials, keys, or arbitrary user files —
  only the backend's own sandbox does that. Documentation must not imply otherwise, and
  `--access read-only` is scoped to what the wrapper can genuinely enforce.
- **Interaction outcome joins the short list of genuinely shareable contracts** (ADR-007 item 6),
  alongside wrapper-managed worktrees. Interaction *mechanics* remain backend-native.

---

## Kill criteria — when to abandon ADR-001 and split into three projects

Check for these before committing, and re-check at each phase boundary:

- **R1** The shared job engine cannot stay free of backend branches — `if backend == opencode`
  checks accumulating through locking, finalization, cancellation, and status handling means the
  adapter boundary has failed.
- **R2** A shared `status.json` cannot describe jobs without changing the meaning of existing
  fields. Nullable fields and a namespaced `backend_state` object are fine; backend-dependent
  meanings for `done`, `cancelled`, `session_id`, `access`, or `result` are not.
- **R3** The implementations require incompatible deployment environments — e.g. `dcli-opencode` must
  become a continuously running service with fundamentally different packaging/security needs, not
  merely a per-job helper.
- **R4** Release coupling prevents safe operation — a broken opencode adapter forcing an otherwise
  valid `ccodex` release to be withheld. Try independently versioned adapter packages first.
- **R5** No stable cross-backend core exists — `run`, `submit`, `wait`, `read`, `cancel`, `cleanup`
  cannot retain outcome-level contracts across all three.
- **R6** `dcli-claude` recursion cannot be bounded — workers repeatedly rediscover and invoke `dcli-claude`,
  cannot run isolated, or leave native children outside containment. Isolate or abandon `dcli-claude`
  rather than weakening all backends.
- **R7** Native ownership becomes mandatory — `dcli-claude` must use `claude agents` and `dcli-opencode`
  must use a persistent shared server while `ccodex` stays process-owned.
- **R8** Security review requires separate trust or update boundaries for the Node HTTP backend.

**None of the currently known differences reaches these thresholds.** They argue for strict
adapters and backend-specific skills — not separate projects.
