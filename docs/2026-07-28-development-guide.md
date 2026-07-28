# dcli — development guide

Date: 2026-07-28. Read this **before writing any code**.
Companions: [CLI study](2026-07-28-opencode-cli-study.md) (*study §n*),
[ADRs](2026-07-28-architecture-decisions.md) (*ADR-n*), [design spec](2026-07-28-design-spec.md)
(*spec §n*).

This document is the operational half of the design: what to build in what order, the mistakes
that are already known to be waiting, and the rules that keep the ADR-001 adapter boundary honest.

---

> **`AGENTS.md` at the repository root is the consolidated standing-rules version of this document's §1–§3.**
> It is shorter, ordered by cost, and includes items mined from the predecessor's commit history and backlog that
> are not repeated here. Read it first; this guide adds the testing strategy and phase order.

## 1. Inherited pitfalls — these are not hypothetical

Every item in this section is a **real bug already paid for** during `ccodex` development
(PowerShell, Codex backend). They are mechanism-independent and will recur here unless designed
against. Each must land with a regression test; if a change of yours makes one of these tests fail,
**the test is right and the change is wrong**.

### 1.1 Never "write stdin, then read stdout"

The single most expensive `ccodex` bug. A child can fill either OS output pipe before it drains its
own stdin, deadlocking parent-writes against child-writes. It showed up with a ~100 KB embedded
review diff — which `--embed-diff` makes the *default* path (spec §11).

Required order: open the events writer, arm stdout and stderr readers, **then** write stdin.
Start the hard-timeout deadline immediately after process start, so a blocked write is budgeted.
On timeout or writer failure preserve this teardown order: close stdin → kill the process tree →
boundedly observe writers/readers (a surviving grandchild may hold a pipe open) → flush partial
stdout/stderr → return the timeout sentinel or rethrow.

In Node this means `child.stdout`/`child.stderr` consumers attached before the first
`stdin.write()`, and never `await` a full-buffer read before writing.

### 1.2 Bound the post-exit drain

A normally exited child can still leave a redirected stream open via a surviving grandchild.
Draining "until EOF" hangs. Bound it (spec §13: 5 s), flush what you have, and move on.

### 1.3 Process identity is `pid + creation time + image path`

PID reuse is real. Any code that kills or health-checks a process must verify **all** parts before
acting. `ccodex` uses `"<pid>;<UTC start time 'o'>"` as a composite identity — carry that idea over.
Never kill by executable name.

### 1.4 `phase` is not a terminal signal

`ccodex` has a live hazard where a turn completes and `result.md` exists while a lingering
descendant keeps the tree alive — `phase=finalizing`, `status=running`, indefinitely. Observed on
this host during the very study that produced these docs: a Codex job sat in `finalizing` for 14+
minutes because a long-lived `pwsh.exe` command-safety helper never exited.

Consequences for this project: callers key off `state`, never `phase`; `status` must surface a
warning when the process outlives the completion evidence; and the design must decide explicitly
whether completion evidence plus a stale process is `done` or `failed` — not leave it ambiguous.

### 1.5 `status.json` discipline

Single writer per lifecycle stage. Every update goes through the atomic temp+rename writer, with a
**bounded retry on the concurrent-reader window** (a reader can catch the rename). Fields are
append-only. Reconciliation must **preserve** `failure_reason` and `backend_session_id` — a past
`ccodex` bug dropped them. Keep `backend_exit_code` and `command_exit_code` as distinct fields;
never introduce a generic `exit_code`.

### 1.6 Raw backend events never reach the parent's stdout

They go to `backend-events.jsonl`. The parent prints only `result.md` content (and job ids for
`submit`). Assert stdout **byte-exactness** in tests — agents parse this.

### 1.7 UTF-8 without BOM, always, and read child output as UTF-8 explicitly

All wrapper-authored files are UTF-8 without BOM, through shared writer helpers only. Study §4
observed mojibake reading opencode's assistant text through a default pipeline — set the child
stdout encoding explicitly; never rely on the console code page.

### 1.8 The installer mirrors, never merges — and the mirror needs refusal guards

`Copy-Item -Recurse -Force` over an existing install *merges*, so a module renamed or deleted in a
newer version survives as a stale file. Stage the new tree at `<dest>.staging` and swap it in whole,
removing the old copy only after the complete new one exists.

Two refusal guards are load-bearing (a Codex review found that without them, pointing the install
dir at `%LOCALAPPDATA%` made the script dir the job-state root and the mirror **deleted all job
state**): refuse a script dir colliding with the state root, and refuse replacing an existing
non-empty dir lacking the tool's marker file.

### 1.9 Executable resolution must pick the *executable*

npm installs both `.cmd` and `.ps1` shims; PowerShell ranks the script above the application, and
`Process.Start` cannot execute a `.ps1`. On Windows, resolve deliberately to the executable form and
test with an npm-shaped PATH. `opencode` is a `.exe` here (study §1), but `claude` and `codex` are
npm-installed — this bites.

### 1.10 Validate ranges *before* converting or mutating

Three separate `ccodex` bugs: hard-timeout range validation must precede millisecond conversion;
cleanup's repo-filter validation must precede any mutation; delegation integer knobs must share one
strict range path. Generalize: validate → then convert → then act. Never the other way.

### 1.11 A findings appendix that fails to parse must not read as "clean"

A real `ccodex` bug: a malformed appendix degraded into a clean-review verdict. `findings` becomes
`null` and the prose is preserved (spec §11) — an unparseable appendix is never a pass.

### 1.12 Launch-failure orphans

If the worker dies between spawn and startup sentinel, something may still be running. Detect and
clean up; never leave an untracked process holding a lock or a worktree.

### 1.13 Detach must break away by construction

`ccodex` uses CIM `Win32_Process.Create` in production for breakaway, and `Start-Process` in tests
for env inheritance — **both paths must stay tested**. Whatever Node equivalent is chosen, the
production detach path and the test detach path will differ; test both.

---

## 2. New pitfalls specific to this project

### 2.1 The study §5 hang is a *distinct failure class*, not a timeout

If a permission or question request is pending while the session reports `busy` and no event has
arrived within the watchdog window, that is `permission_or_sandbox` / blocked. Reporting it as
`timeout` destroys the diagnosis. This is the entire justification for ADR-002 — do not let it
collapse back into a generic timeout at implementation time.

### 2.2 Never classify from a bare HTTP status code

Study §4: opencode reported **credit exhaustion as HTTP 401** with
`responseBody.error.type == "CreditsError"`. Classifying that as `auth` sends the operator to
re-authenticate a working login. Discriminate on the structured error type. Follow the precedence
ladder in spec §8 and leave `failure_reason` null rather than guessing.

### 2.3 `directory` / `workspace` routing is the largest correctness footgun

Every opencode HTTP endpoint takes optional `directory` and `workspace` query parameters. A missing
parameter on one endpoint can inspect or mutate **the wrong repository**. Establish one canonical
job directory, apply it to launch cwd + every request, and **verify the effective project identity
before sending the first prompt** (`GET /project/current`).

### 2.4 Do not trust `/doc`, and do not trust `--help`

162 paths is not a contract. Depend on a small pinned subset; capability-probe at startup; reject
incompatible versions with a clear diagnostic; tolerate additive fields and unknown event types.
Separately: **never infer support from a flag appearing in `--help`** (spec §10) — the flag may
exist and not work, as study §8 shows for structured output.

### 2.5 Top-level event `type` and `part.type` use different casing

Study §4: `{"type":"step_start", ..., "part":{"type":"step-start"}}` — underscores at top level,
hyphens inside. Both appear in the same object. Do not normalize one and assume the other.

### 2.6 `step_finish` is not completion

Only `reason == "stop"` on the **final** assistant message is. A tool-using turn emits
`step_finish(reason="tool-calls")` mid-flight (study §4). Group by `messageID`; never blindly
concatenate text across messages.

### 2.7 SSE is a progress channel, not the source of truth

Reconnects, buffering, missed events, and server termination are all possible. Declare completion
only from a terminal session state, reconciled against `GET /session/status` and message
retrieval — **never** from SSE closure alone.

### 2.8 Structured output is a trap in opencode 1.18.7

Study §8: a `format: json_schema` request returned no parts **and permanently corrupted message
read-back for that session**. There is no safe in-session fallback. ADR-006: don't use it.

### 2.9 One canonical permission ruleset per job, and never mutate user config

Study §7 verified that a wildcard `allow` overrides a config `ask`, but proved nothing about
precedence, ordering, patterns, or `deny`. Write contract tests before relying on fine-grained
rules. Broad `allow` is an explicit opt-in mode, never a default. Never write to the user's
permanent opencode configuration.

### 2.10 `dcli-claude` recursion

Claude wrapping Claude requires the ADR-005 safeguards. Test that a worker cannot re-enter the
delegating skill, and that direct self-recursion fails fast with exit `2`.

### 2.11 The long-lived server's own pipes must be drained too

A gap found in review. Concurrent draining was specified for short-lived children, but the per-job
`opencode serve` process outlives them all. If its stdout/stderr is piped and not continuously drained,
a verbose debug dump fills the buffer and **hangs the server** — a never-hang violation inside the
never-hang design. Capture to a size-capped rotating job log and drain for the whole server lifetime.

### 2.12 Never scrape a human log for a machine value

Specifically: the bound port. "Parsing human startup logs is not a contract." If opencode offers no
machine-readable bound-port handshake, reserving a port yourself introduces a close-then-bind race —
accept it, bound the retries, and **test the race**. Confirm the port with `GET /global/health` either
way.

### 2.13 Do not let the native helper grow

The feature-creep path is predictable: "while we're here, let's also expose the process tree as JSON",
"let's add event-id-based kill verification". Each addition is ten lines and independently reasonable;
after five the helper is a real native addon with its own multi-platform prebuild pipeline, and the
project has two implementations. Banned in the helper: telemetry, path resolution, string manipulation,
business logic, process-tree introspection, timeout or cancellation-rung decisions, job state, backend
knowledge. Any expansion is a design-review item (ADR-008).

### 2.14 A malformed findings appendix is not "no findings"

Token truncation can leave the marker present and the JSON incomplete. Reporting that as a clean review
for a diff with real defects is the failure that teaches users to distrust the tool. Carry
`findings_status: ok | absent | malformed` — `findings: null` alone cannot distinguish "found nothing"
from "unparseable". Tolerate a preamble before the marker (models drift); reject trailing content after
the appendix, duplicate markers, oversized appendices, and non-repo-relative paths. Treat appendix
content as untrusted input.

### 2.15 Redact before writing, never on read

Once a token is on disk it has leaked. The failure classifier deliberately reads provider error bodies,
which is exactly where tokens live. See spec §19 for the channel list and the never-write list. Test it
with a planted token grepped across the whole job directory.

### 2.16 Per-job server hygiene

Random per-job password via environment (never on a command line, never in normal logs). Parse the
bound port from startup output, then confirm with `GET /global/health` — `--port 0` behavior is
unverified (study §11.2). Close every response body and SSE connection. Bound concurrent active
jobs. Record server metadata in `<state-root>/servers/<job-id>.json` so a crashed wrapper's servers
are still findable.

---

## 3. Coding conventions

- **Node.js: plain JavaScript, no build step** (ADR-003). Recover type safety with JSDoc +
  `checkJs` in development, checked-in JSON schemas or explicit validators at every protocol
  boundary, strict handling of unknown event variants, and `AbortController` deadlines on every
  HTTP operation.
- **One explicit state machine** for job lifecycle. Not promise choreography spread across commands.
- **No adapter-specific conditionals in `core/`.** This is ADR-001 kill criterion R1; treat a
  `if (backend === 'opencode')` in core as a design bug, not a shortcut.
- **Backend-specific data lives only in `status.json.backend_state`.** Never a new top-level field
  with backend-dependent meaning (R2).
- **Argument arrays, never shell strings.** No `cmd.exe /c`, no `/bin/sh -c` for ordinary
  invocation. `command.txt` is quoted for humans and never executed.
  *If* a Windows `.cmd` shim must be invoked (`claude`, `codex`), the quoting is two-layered and
  deliberate — pre-quote with Win32 rules **plus** force-quote cmd metacharacters
  (`& | < > ( ) ^ %`), and assign the joined string directly rather than letting the runtime
  re-escape an already-quoted line. Do not fork a second quoting implementation for the detach path.
- **Files single-responsibility and independently testable.** `core/*` modules must be unit-testable
  without a backend.
- **Contracts are append-only.** Never rename or repurpose an existing exit code or status field —
  the installed skills, commands, and rules depend on them.
- **Every blocking boundary has a finite default** (spec §13). A new `await` without a deadline is
  a review-blocking defect.

---

## 4. Testing strategy

Four layers, run and reported independently:

1. **Core tests** against a deterministic **fake adapter**. No real CLI. This is where lifecycle,
   locking, reconciliation, exit codes, and path normalization are proven.
2. **Adapter unit tests** over recorded fixtures: golden argv, recorded NDJSON/SSE/stream-json
   streams, recorded OpenAPI responses, and failure payloads.
3. **Contract tests** that *every* adapter must pass — the same suite run three times. This is what
   keeps the boundary honest.
4. **Opt-in live integration tests** pinned to tested backend versions.

Required fixture backends (a fake executable / fake HTTP server producing controlled behavior):

- Well-formed stream; malformed JSON lines; oversized single line; unknown event types.
- Exits 0 with no assistant text.
- **Hangs with zero output** (the study §5 class). `opencode debug wait` is a ready-made
  indefinite-hang fixture.
- Emits a permission request and waits.
- Emits a question and waits.
- Fills its stdout pipe before reading stdin (the §1.1 backpressure case).
- Spawns a grandchild that outlives it and holds a pipe open.
- Dies between spawn and startup sentinel.

### Fault injection comes BEFORE broad feature tests

Adopted from review. Kill the controller at each of these points and assert the job is either
recoverable or explicitly `interrupted` — **never stuck `running`**:

1. Immediately before process spawn.
2. Immediately after process spawn, before durable identity is recorded.
3. During port discovery.
4. After the backend session exists but before it is recorded.
5. Mid-turn, with a pending interaction.
6. Before the snapshot commit.
7. After the snapshot commit, before terminal publication.
8. Between the cancel request and the hard kill.
9. During terminal publication itself.

Each must also leave no orphaned backend process (ADR-008: controller death kills the tree) and no held
lock or worktree.

Specific must-have tests:

- **Windows Job Object containment**: grandchildren die; wrapper death kills the tree; the degraded
  `taskkill` fallback is exercised and marks `containment.degraded`.
- **Unix process-group** equivalents.
- Worktree create / diff / apply / conflict / rollback, including verified restoration on exit `25`.
- Lock contention and PID-reuse simulation.
- Abrupt worker death → stale-job reconciliation → never permanently `running`.
- Findings-appendix validation, including the §1.11 malformed-is-not-clean case.
- Failure-classification precedence, including the §2.2 `401`+`CreditsError` case.
- Generation tests: no stale generated files; **no adapter's flag appears in another adapter's
  skill**; installed files byte-match the repo.

Report per suite so one broken adapter does not mask the rest:

```
core: pass
codex adapter: pass
opencode adapter: pass
claude adapter: pass
contract (codex/opencode/claude): pass
opencode live: skipped (not installed)
```

Provide a **quick** suite for iteration (skips live/E2E and says which) and a **full** suite that
must be green before anything is declared done or committed.

---

## 5. Suggested phase order

Each phase ends green on the full suite, with docs updated in the same piece of work.

**Revised 2026-07-28 after adversarial review** — see
[review record](2026-07-28-architecture-review-record.md). The previous order built the engine against
opencode alone and deferred Codex to second-to-last. Both reviewers independently identified that as
the design's top risk: the adapter contract would be over-fit to HTTP sessions, and the CLI adapters
would then need fake sessions or a parallel sync path in the engine.

| Phase | Deliverable | Exit criterion |
|---|---|---|
| **0** | Repo skeleton, doc set, **fact-based adapter contract written down first (ADR-007)**, fake adapter, test harness, quick/full runner | Contract document exists and the fake adapter satisfies it; suite runs |
| **1** | Core job engine: state root, job/attempt dirs, journal + `status.json` projection, lifecycle **reducer**, locking, process identity | Core tests green against the fake adapter |
| **2** | Containment: native Windows helper + Unix process groups; deadlines; adapter-declared cancellation rungs. **Run the Job-Object-on-Bun experiment here** | Grandchild-kill and controller-death chaos tests pass; degraded path marks itself; **ADR-003 confirmed or reversed to Go** |
| **3** | Fault-injection harness at every defined crash point | Every crash point yields a recoverable or explicitly `interrupted` job; nothing is stuck `running` |
| **4** | Commands: `run`, `submit`, `status`, `wait`, `read`, `list`, `cancel`, `tail`, `debug`, `cleanup` | Contract suite green on the fake adapter |
| **5** | **Two thin adapter slices in parallel: opencode + codex.** Just enough of each to run a prompt and collect a result | **Contract suite green on both.** This is the phase that proves the boundary is not HTTP-shaped |
| **6** | **opencode adapter in full** — per-job server, port handshake, auth, directory routing, SSE + status reconciliation, interaction handling, capability probe, admission control | Live smoke against 1.18.7; the study §5 hang reported as **blocked**, not timeout; server output drained for its whole lifetime |
| **7** | `review` + findings contract + `--embed-diff` + the model-output corpus fixture | Findings validation green incl. truncated/duplicate/preamble cases; live scoped review works |
| **8** | Worktrees: `implement`, `diff`, `apply` (+ `--stat`/`--name-only`, `--reset-author`/`--message`) | Conflict/rollback green; apply-conflict verifies restoration; snapshot commit bypasses hooks and signing |
| **9** | `resume` (all three kinds) / lineage / `doctor` probes / `capabilities` / redaction | Each resume kind round-trips; `doctor --json` returns its envelope even when checks fail; redaction test finds no planted token on disk |
| **10** | Claude Code integration generated from source; installer + byte-match verification | Generation and install tests green; no cross-adapter flag leakage; installed skill byte-matches repo |
| **11** | **codex adapter in full** (behavioral parity with today's `ccodex`) | Contract suite green; parity verified |
| **12** | **claude adapter** incl. ADR-005 recursion guards | Contract suite green; recursion fails fast; `--bare` auth behavior probed |

Backend order remains **opencode → codex → claude**, as required. What changed is that Codex's
*adapter proof* moves up to phase 5 and runs alongside opencode's, while its *full* adapter stays at
phase 11. opencode is the hardest and shaped the architecture; Codex is the cheapest counterexample
proving the contract works for a non-HTTP backend; Claude is last because it has the most unverified
behavior and the only recursion hazard.

**Migration note:** production `ccodex` keeps running unchanged throughout. Do not migrate job state —
let old `ccodex` jobs age out under their own state root and start clean under the new one. The earlier
justification for deferring Codex ("porting risks a live regression") does not apply to building an
adapter here, because this is a separate repository and the production command is untouched.

---

## 6. Documentation maintenance rule

A change is not done until the docs reflect the new reality, **in the same piece of work** — never
as a deferred task:

- **`README.md`** (user-facing only): usage, features, cheat sheet.
- **`docs/reference/*`** (developer-facing): per-command/flag reference and contract tables.
- **`integration/source/*`**: whenever a command, flag, or behavior changes that an agent should
  know about. Stale sources mean every future agent session is taught the old behavior — and here
  the generated skills are checked in, so CI must fail on staleness.
- Re-run the installer after user-facing or template changes, then **verify the installed copies
  byte-match the repo** (hash per file).

Never use `README.md` as a technical source when developing.

---

## 7. Process conventions

- **Git:** one commit per implementation task. TDD per task: write failing tests → verify red →
  implement → verify green → full suite → commit. **No co-author trailers.**
- **Dogfooding is mandatory and has paid for itself.** After each phase, run a scoped second-opinion
  review of that phase's diff (`--range <base>..HEAD --path <paths> --embed-diff`). On `ccodex` this
  repeatedly found real issues internal review missed — including the installer state-root deletion
  in §1.8. Triage every finding: adopt with action, or reject with a stated reason.
- **Backend upgrades are a first-class event.** Each adapter owns an upgrade-check workflow and its
  own golden fixtures; updating opencode must not rewrite Codex or Claude fixtures. `ccodex` needed a
  whole `codex-upgrade-check` skill for exactly this — carry the pattern over per adapter.
- **Never commit** scratch/agent-ledger directories.

---

## 8. What is deliberately unresolved

Do not start phase 4 without closing these; they are the assumptions the architecture rests on
(full list in study §11 and spec §19):

1. `PermissionRuleset` precedence / ordering / pattern semantics and `deny` behavior.
2. Whether `--port 0` reliably reports the bound port, and on which stream.
3. Basic-auth mechanics on every endpoint used.
4. Whether SSE can miss events, and what reconciliation is sufficient.
5. ~~Whether a Job Object can be attached before the Bun-built opencode binary spawns descendants,~~
   ~~and its breakaway behavior. **This one gates ADR-003** — if it fails, the answer is pure Go.~~
   **RESOLVED 2026-07-28 by experiment (ticket 06).** Yes to all four questions.
   ADR-003 confirmed; Go reversal not required.
6. Whether Claude Code's `-p` can block on permissions the way opencode does, and whether
   `--input-format stream-json` provides a control channel to answer them.

Prototype 5 first. It is the cheapest experiment with the largest architectural consequence.
