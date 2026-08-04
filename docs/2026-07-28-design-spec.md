# dcli — design specification

Date: 2026-07-28. Status: implemented: core commands, lifecycle/state contracts, worktree/review/apply,
resume lineage, all three adapters, generated integration, installer, redaction, admission, and bounded test
runner. Known blockers: opencode `unknown` status termination (ticket 81); containment is specified but not yet
wired into production adapter launches (ticket 78).
Companion documents: [CLI study](2026-07-28-opencode-cli-study.md) (cited *study §n*),
[ADRs](2026-07-28-architecture-decisions.md) (cited *ADR-n*),
[development guide](2026-07-28-development-guide.md).

Reference implementation studied: `ccodex` (PowerShell, complete, in production) — its contracts are
the starting point, not a constraint.

---

## 1. Purpose and product boundary

One tool through which Claude Code delegates scoped work to a coding-agent CLI, with durable job
artifacts and stable machine-readable contracts. Three backends: **Codex CLI**, **opencode CLI**,
**Claude Code CLI**.

Installed commands (ADR-001):

```
dcli-codex      # backend: codex
dcli-opencode   # backend: opencode
dcli-claude     # backend: claude
delegate    # umbrella: dcli --backend <b> ... ; dcli backends --json
```

The shim name is the backend type tag. Agents use the shims; they must not have to repeat
`--backend` on normal calls. The umbrella exists for scripting and diagnostics.

Supported: synchronous second opinions / brainstorming / reviews / tests; detached background jobs
with durable status and logs; structured review findings; session continuation; isolated
implementation in detached git worktrees; explicit inspection before applying worker changes;
reliable timeout enforcement and cancellation.

### Non-goals

Reimplementing any TUI. Managing providers, MCP servers, plugins, or backend configuration.
Exposing a backend's database as ours. Automatically applying implementation output. Letting review
jobs modify the source tree. Automatically retrying quota / auth / permission / malformed-result
failures. Hosting a remotely reachable server. Sharing one backend server between OS users.
Supporting arbitrary backend versions without a compatibility check.

---

## 2. Layered architecture

```
        shims: dcli-codex | dcli-opencode | dcli-claude | dcli
                          │
                  command layer (core)
   run submit status wait read list resume cancel tail
   diff apply debug cleanup doctor capabilities
                          │
                  job engine (core)
  state root · job dirs · status.json · lifecycle · locking
  process identity · containment · deadlines · worktrees
  snapshot/diff/apply · results · exit codes · retention
                          │
                 adapter interface (§9)
        ┌─────────────────┼─────────────────┐
     codex            opencode            claude
   codex exec     per-job serve+HTTP     claude -p
   NDJSON         SSE + REST             stream-json
        └─────────────────┴─────────────────┘
                          │
              native containment helper (ADR-003)
```

**Hard rule:** no adapter-specific conditionals in the job engine. A backend branch inside core is
the ADR-001 kill criterion R1.

---

## 3. Repository layout

```
dcli/
  cli/                       # shims; select backend BEFORE argument parsing
    dcli.js  dcli-codex.js  dcli-opencode.js  dcli-claude.js
  core/
    job-store.js  job-schema.js  lifecycle.js  locking.js
    process-identity.js  containment.js  deadlines.js
    bounded-tail.js  inject-points.js
    worktree.js  snapshot.js  results.js  exit-codes.js
    capabilities.js  validate.js
    commands/                # one file per core command, plus attempt.js
                             # (prepareBackend + runAttempt, shared by
                             #  run / resume / submit — see 2026-07-31)
  adapters/
    codex/     adapter.js  event-parser.js  capabilities.json  compatibility.json
    opencode/  adapter.js  server-manager.js  http-client.js  sse.js
               permissions.js  capabilities.json  compatibility.json
    claude/    adapter.js  stream-json-parser.js  recursion-guard.js
               capabilities.json  compatibility.json
  native/
    windows-job-helper/      # ADR-003; prebuilt binaries checked in per arch
  integration/
    source/  core.md  router.md                     # shared + router
             backend-codex.md  backend-opencode.md  backend-claude.md
             # the backend-* prefix is required: a file named claude.md is
             # indistinguishable from CLAUDE.md on a case-insensitive
             # filesystem, and gets loaded as agent instructions.
    generated/               # checked in; CI fails if stale
      skills/{dcli-codex,dcli-opencode,dcli-claude,dcli}/SKILL.md
      commands/  rules/  worker-prompts/
  tests/
    core/  contract/  adapters/{codex,opencode,claude}/  integration/  fixtures/
  docs/
  install.ps1  install.sh
```

Adapter implementation languages may differ behind the boundary (ADR-003).

---

## 4. State root and job layout

Platform-native:

```
Windows  %LOCALAPPDATA%\dcli\        config: %APPDATA%\dcli\
macOS    ~/Library/Application Support/dcli/
Linux    ${XDG_STATE_HOME:-~/.local/state}/dcli/
```

**The state root is user-space and never derived from the repository.** `DCLI_STATE_ROOT` overrides it;
nothing else does. In particular `--repo` must not influence it — jobs are already namespaced by
`<repo-key>` inside the root, so a per-repo `<repo>\.dcli-state` buys no isolation, and it broke job
identity: `run --repo X` wrote to `X\.dcli-state` while a later `status <job-id>` without `--repo` read
the user-space root and reported **"Job not found"** for a job that had completed successfully. Never
reintroduce a repo-derived state root, and never place state in a temp directory — job records must
outlive the machine's temp cleanup to keep `status`, `read` and `resume` meaningful.

```
<state-root>/
├── jobs/<repo-key>/<job-id>/
│   ├── prompt.md                 # exact prompt sent
│   ├── command.json              # structured invocation (argv / HTTP request shape)
│   ├── command.txt               # human-readable only; never used for execution
│   ├── status.json               # §5
│   ├── result.md                 # atomically persisted final assistant text
│   ├── findings.json             # §11; null when absent/invalid
│   ├── backend-events.jsonl      # raw NDJSON / SSE, verbatim, append-only
│   ├── stdout.log  stderr.log  worker.log
│   ├── debug.json
│   ├── worker-started.json  worker-complete.json   # startup / completion sentinels
│   ├── cancel.request
│   └── artifacts/
├── index/<job-id>.json           # for cross-repo `list`
├── worktrees/<job-id>/
├── locks/
└── servers/<job-id>.json         # opencode per-job server metadata
```

### Attempts and the journal (review record findings 5–6)

A job has one or more **attempts**. Resume and retry create a new attempt and must never overwrite a
previous attempt's pid, session id, logs, failure, or result. Per-attempt artifacts therefore live
under `attempts/<n>/`, and `status.json` at the job root is a **projection** of the latest attempt plus
job-level lineage.

```
jobs/<repo-key>/<job-id>/
├── status.json            # PROJECTION — atomically replaced, safe for readers
├── journal.jsonl          # AUTHORITATIVE — append-only lifecycle/attempt events
└── attempts/<n>/          # prompt.md, command.json, result.md, findings.json,
                           # backend-events.jsonl, stdout/stderr/worker logs, sentinels
```

When an attempt collects a result, it writes `result.md` before its terminal status projection. The
corresponding `result_bytes` is the exact UTF-8 byte length of that artifact (including `0` for an empty
result). If that write fails, the attempt is terminally failed rather than reporting a clean zero-byte result.

`status.json` cannot safely be both the public projection and the transactional store. Authoritative
lifecycle transitions are appended to `journal.jsonl`; the projection is derived from it. Crash points
are defined explicitly around: process spawn, port discovery, session creation, snapshot commit,
cancel request, hard kill, and terminal publication — and each is a fault-injection test
(development guide §4).

`repo-key` = first 12 lowercase hex of SHA-256 over the normalized canonical repository path; the
full path stays in metadata. Never reuse a job or attempt directory.

All wrapper-authored text is **UTF-8 without BOM**. JSON writes are write-new → flush → close →
atomic replace. Detect filesystem capabilities before assuming atomic rename.

---

## 5. `status.json` contract

Schema version 1. Fields are **append-only** — never rename or repurpose. Missing data is `null`,
never omitted.

```json
{
  "schema_version": 1,
  "job_id": "20260728T075904Z-xdzv9ovy",
  "backend": "opencode",
  "backend_version": "1.18.7",
  "adapter_version": "1.0.0",
  "repo_key": "f8d3ffc01046",
  "repo_root": "D:\\src\\project",
  "execution_root": "C:\\...\\dcli\\worktrees\\20260728T075904Z-xdzv9ovy",
  "mode": "review",
  "access": "read-only",
  "state": "running",
  "phase": "agent_running",
  "created_at": "2026-07-28T07:59:04.000Z",
  "started_at":  "2026-07-28T07:59:05.000Z",
  "updated_at":  "2026-07-28T07:59:12.000Z",
  "finished_at": null,
  "heartbeat_at": "2026-07-28T07:59:12.000Z",
  "worker_pid": 1234,
  "worker_identity": "1234;2026-07-28T07:59:04.5136608Z",
  "containment": { "kind": "job-object", "handle_owner_pid": 1234, "degraded": false },
  "backend_pid": 1250,
  "backend_session_id": "ses_...",
  "backend_state": { },
  "capabilities_snapshot": { },
  "execution_owner": "wrapper",
  "model": "opencode-go/deepseek-v4-flash",
  "agent": "delegate-review",
  "parent_job_id": null,
  "root_job_id": "20260728T075904Z-xdzv9ovy",
  "session_strategy": null,
  "group": null,
  "label": null,
  "hard_timeout_sec": 1800,
  "cancel_requested_at": null,
  "command_exit_code": null,
  "backend_exit_code": null,
  "result_bytes": 0,
  "tokens": { "input": null, "output": null, "reasoning": null,
              "cache_read": null, "cache_write": null, "total": null },
  "cost": null,
  "failure_reason": null,
  "failure": null,
  "worktree": { "path": null, "base_commit": null, "result_commit": null, "changed_files": null }
}
```

Add per attempt: `attempt`, `attempt_id`, `attempt_state`, `execution_token`, `containment.degraded`,
`findings_status`. `state` may additionally be `interrupted` (ADR-008).

`backend_state` is the **only** place backend-specific data may live. Anything a backend needs that
does not fit an existing shared field goes there — never as a new top-level field with
backend-dependent meaning (ADR-001 R2). It carries **its own `schema_version`** and a migration
policy: the engine treats the payload as opaque, but recovery needs the matching adapter version to
interpret it, so an unversioned payload is unrecoverable (review record finding 18).

`capabilities_snapshot` records the effective capability set at job creation, so a later
backend upgrade cannot retroactively change how an old job is interpreted.

`failure`, when present:

```json
{ "class": "quota_or_rate_limit", "message": "...", "source": "event|stderr|http|exit|wrapper",
  "matched_signal": "CreditsError", "confidence": "high", "http_code": 401, "retryable": false }
```

---

## 6. Lifecycle

**States:** `created` → `running` → one of `done` | `failed` | `timed_out` | `cancelled` |
`interrupted` (controller died — ADR-008; recoverable only by a **new attempt**).

**Terminal state is decided by an engine-owned reducer over adapter facts (ADR-007).** There is no
universal completion criterion: for a CLI adapter, `process_exited` plus a validated result plus a
completed drain may be terminal; for opencode, an idle `backend_status` is one input among several.
Adapters never declare terminality.

**Phases:** `validating`, `preparing`, `worktree_creating`, `worker_launching`, `server_starting`
(opencode), `session_creating`, `agent_starting`, `agent_running`, `result_collecting`,
`snapshot_committing`, `finalizing`, `terminal`.

`phase` is progress information, **not** a terminal signal. A job in `finalizing` with completion
evidence present is still not terminal — `ccodex` has this exact hazard today, where a turn
completes and the recorded result file exists while a lingering descendant keeps the process tree
alive. Callers must key off `state`, and `status` must surface a warning when
`phase == finalizing` and the process has outlived the completion evidence.

**Reconciliation.** `status` must never report a job as permanently `running`. It reconciles to
`failed` with `failure_reason: worker_lost` when: the worker identity is gone, the completion
sentinel is absent, the heartbeat is stale, or the backend process no longer exists while result
and event evidence indicate a terminal outcome. Heartbeat interval: 5 s.

**Launch identity.** A detached `submit` worker is recorded immediately after process creation, before
the launcher waits for worker startup. The journal carries its `worker_pid`, `worker_identity` (pid plus
creation time when the OS can report it), and `execution_token`; admission queue re-launches replace the
identity before the replacement can be lost. A `started` fact also journals the shared `backend_pid`
and `backend_session_id` fields so live records expose backend ownership without a backend-specific
condition in `core/`.

---

## 7. Exit-code contract

Stable and append-only. Backend-native codes (opencode returns only `0`/`1`, study §4) are
translated, never surfaced.

| Code | Meaning |
|---:|---|
| `0` | Success |
| `2` | Usage / validation error, incl. unsupported-option rejection (ADR-004). No job created. **The `--json` output must carry a distinct `failure_class`** — `usage_error` ("your syntax is wrong") and `unsupported_capability` ("a valid request this backend cannot serve") are different problems for an agent, even though they share a shell exit code. |
| `3` | Job not found. (2026-08-04) A job id that does not match `^\d{8}T\d{6}Z-[a-z0-9]{8}$` is rejected in `validatePositionals()` as **`2`**, at the argument boundary — the only place a foreign id enters, so core lookups keep taking ids the engine minted: an id minted by another runtime cannot name a dcli job, and "Job not found: <repo_key>/<id>" told the caller to keep hunting for it. (2026-08-01) Absence must be **proven by `ENOENT`/`ENOTDIR`**, never inferred from a failed stat: `fs.existsSync()` returns false for *any* stat error, including the `EPERM`/`EBUSY` Windows hands out on a tree being written or scanned, so it cannot tell "no such job" from "could not look". A directory that exists but whose record cannot be read is **`17`**, not `3` — exit 3 tells an agent to stop looking. `resume`, `submit --resume`, `diff` and `apply` each had their own catch-all mapping every read failure to `3`; they all go through `loadJobOrThrow()` now. (2026-07-31) Determined by the job directory's existence, **not** by whether `regenerateStatus()` throws — an absent journal regenerates to the default projection (`job_id: null`, `state: "created"`), so a typo'd id used to read as a freshly created job at exit 0 and an agent would poll it forever. All read-side commands go through `loadJobOrThrow()`. |
| `4` | Job not terminal (e.g. `read` on a running job) |
| `10` | Backend/provider execution failed (see `failure_reason`) |
| `11` | No usable assistant result |
| `12` | Environment or compatibility failure |
| `13` | Authentication failure |
| `14` | Quota or rate-limit failure |
| `15` | Permission / access-policy denial |
| `16` | Network / transport failure |
| `17` | Lock acquisition or corrupt-state failure |
| `18` | Worker launch / startup-sentinel failure |
| `20` | Caller's `wait` timed out; job still active |
| `21` | Cancellation could not be confirmed |
| `22` | Session missing / expired / incompatible with resume |
| `23` | Repository or worktree preparation failure |
| `24` | Job hard timeout; process tree killed |
| `25` | Apply conflict; main repository verified restored |
| `26` | Backend output/event protocol incompatible or malformed |

---

## 8. Failure classification

**Precedence:** wrapper validation/launch errors → explicit structured backend/HTTP errors →
permission request/denial events → HTTP status *with* provider error context → high-confidence
stderr patterns → backend exit code → empty result → unknown.

**Bare numbers must never classify on their own.** Study §4 is the proof: opencode reported credit
exhaustion as HTTP **401** with `responseBody.error.type == "CreditsError"`. Classifying that `401`
as `auth` would send the operator to re-authenticate a working login. The discriminator is the
structured error type, not the status code.

| Class | Reaction |
|---|---|
| `quota_or_rate_limit` | Note it; continue without the delegated work. Never retry-loop. |
| `auth` | Note that credentials need attention (`opencode providers login` / `codex login` / `claude auth`). No retry. |
| `permission_or_sandbox` | Do not broaden automatically. Refine the permission profile or narrow scope on a *future* attempt. |
| `network` | At most one explicit jittered retry, read-only jobs only. |
| `timeout` | Never retry automatically. |
| `no_result` | Preserve events; caller may resume or retry manually. |
| `cancelled` | Intentional. No retry. |
| `lock` | Bounded backoff retry, then fail. |
| `worker_launch` | Run `doctor`. No blind loop. |
| `session_expired` | Start a fresh job; never silently substitute a different session. |
| `apply_conflict` | Restore and report. Never auto-resolve. |
| `protocol` | Requires a compatibility update. |
| `unknown` | Preserve all evidence; recommend `debug` / `doctor`. |

A failure matching no high-confidence signature leaves `failure_reason` null. Treat that as
"read the recorded error and use judgment", not as a retry trigger.

### Interaction outcome — a shared contract (ADR-007)

Interaction *mechanics* are backend-native, but the *outcome* is unified. Without this, `blocked` and
"unattended execution" would mean different things per backend. Every permission or question resolves
to exactly one of:

| Outcome | Meaning |
|---|---|
| `pre_authorized` | The job's declared policy already allowed it; nothing was asked. |
| `denied_by_policy` | The job's declared policy refused it; the backend was told no. |
| `awaiting_authorized_responder` | Something must answer, and an authorized responder exists (attended use, or an explicitly supplied automation policy). |
| `rejected_unattended` | Something must answer, nothing is authorized to. **The job fails as `permission_or_sandbox`/blocked — not as a timeout.** |

`rejected_unattended` is the study §5 hang class, correctly named. An unattended wrapper must never
invent an answer, and must never wait indefinitely for one.

---

## 9. Adapter interface

**Fact-based by construction (ADR-007).** Adapters emit normalized *facts*; the engine owns the
reducer that decides terminal state. Nothing in this interface may traffic in session events, HTTP
concepts, or stream framing.

```
GetIdentity()                      → { backend, adapter_version, state_schema_version }
DetectVersion()                    → backend version from the installed CLI
ProbeCapabilities()                → effective manifest incl. known version defects
DeclareCancelRungs()               → ordered list of rungs this backend actually has
ValidateRequest(request)           → reject unsupported options BEFORE job creation
PrepareInvocation(attempt, request)→ write backend-owned input/config artifacts
Start(attempt)                     → begin execution; return an execution handle
Observe(attempt)                   → stream of FACTS (see below)
SendPrompt(attempt, prompt)        → deliver the prompt
Resume(attempt, kind, prompt)      → kind ∈ continue_backend_session | fork_from_artifacts
Respond(interactionId, decision)   → OPTIONAL, by capability
RequestCancel(attempt, rung)       → perform one declared rung; postcondition stated per adapter
CollectResult(attempt)             → final text, usage, backend session identity
CollectDiagnostics(attempt)        → feeds `debug` / `doctor`; redacted (§20)
Dispose(attempt)                   → release transients; postcondition stated per adapter
Recover(attempt)                   → inspect durable evidence after a controller crash;
                                     postcondition: attempt is terminal or `interrupted` (ADR-008)
```

### The fact vocabulary

Adapters emit only these. A backend-specific fact type would mean the abstraction is wrong.

```
started{ backend_pid?, backend_session_id? }
assistant_text{ message_id, text }
reasoning{ message_id }                    # presence only; content not persisted by default
tool_invoked{ call_id, tool, summary }
tool_result{ call_id, ok, summary }
interaction_pending{ interaction_id, kind: permission|question, detail }
interaction_resolved{ interaction_id, outcome }        # outcome enum per §8
usage_reported{ tokens{...}, cost? }
backend_status{ busy | idle | retrying{ attempt, next_at } }
backend_error{ class_hint?, structured_payload }
process_exited{ code }
stream_closed{ reason }
```

**No universal terminal criterion exists.** For a CLI adapter, `process_exited` plus a validated
result plus a completed drain may be terminal. For opencode, an idle `backend_status` is one input
among several. The reducer decides; adapters never declare terminality.

Optional **extensions** — declared in capabilities, never mandatory members:

```
ListPendingInteractions()   NativeDiff()   NativeApply()   NativeAgentStatus()
```

---

## 10. Capabilities

Static checked-in manifest (intended support) + version compatibility data + runtime probes
(executable presence, advertised facilities). The **effective** result is snapshotted into every job
and reported by `capabilities --json`.

**Never infer support solely from a flag appearing in `--help`.**

```json
{
  "schema_version": 1,
  "backend": "opencode",
  "backend_version": "1.18.7",
  "core": { "run": true, "submit": true, "resume": true, "cancel": true, "wrapper_worktree": true },
  "extensions": {
    "interactive_permissions":   { "supported": true,  "transport": "http" },
    "answerable_questions":      { "supported": true,  "transport": "http" },
    "native_worktree":           { "supported": true,  "stability": "experimental" },
    "native_vcs_apply":          { "supported": true,  "stability": "experimental" },
    "graceful_session_abort":    { "supported": true },
    "schema_constrained_output": { "supported": false, "reason": "known broken in 1.18.7" }
  }
}
```

Compatibility matrix, published and enforced per adapter:

| Adapter | Tested version | Supported range | Status |
|---|---|---|---|
| codex | 0.144.1 | defined range | supported |
| opencode | 1.18.7 | exact/minor range | supported, known defects (study §8) |
| claude | detected | defined range | supported |

Each adapter owns its version detection, min/max tested versions, upgrade probes, known-bad
versions, golden help/OpenAPI/stream fixtures, and its own upgrade-check workflow. One adapter
becoming incompatible must fail **its** `doctor` check only — never block unrelated adapters.

Unsupported versions **fail closed**, before a job is created, with a message naming the supported
range. The failure mode being prevented: opencode renames an endpoint in a future version, every call
404s, and the classifier reports `unknown` while the user concludes the wrapper is broken.

### What `doctor` actually probes

"Smoke test" is not a specification (review record finding 15). Per backend:

| Backend | Probes |
|---|---|
| **opencode** | executable resolves; `--version` in range; per-job server starts and binds; `GET /global/health` returns `healthy` and a matching version; **a shape check on every endpoint the adapter depends on** (not just reachability); optional bounded live smoke |
| **codex** | executable resolves to the *executable* form (not a `.ps1` shim); `--version` in range; delegate to `codex doctor --json`; optional `codex sandbox` spawn-capability probe |
| **claude** | executable resolves; `--version` in range; expected flags present in `--help`; auth reachable — **including whether `--bare` breaks auth on an OAuth-only host**; the adapter builds the envelope itself because `claude doctor` has no `--json` |

Common: state root writable and correctly ACL'd; native containment helper present and
version-compatible; git available and the repo resolvable. `doctor --json` must return its envelope on
stdout **even when checks fail**.

---

## 11. Review design

Scopes: `--staged`, `--working`, `--range <base>..<head>`, `--path <p>` (repeatable),
`--include-untracked`, `--embed-diff`.

**`--embed-diff` is the default.** The wrapper generates the exact diff itself and embeds it
(size-capped) in the prompt. This prevents reviewing a moving target and removes any dependence on
the backend's ability to spawn `git`.

Prompt rules: state intent and focus **neutrally**; explicitly say intent is context, **not**
evidence of correctness; require evidence against the actual diff; deny edits; order findings by
severity; require exactly one findings appendix.

Findings contract (wrapper-parsed — ADR-006, never native structured output):

````markdown
<!-- dcli:findings -->
```json
{
  "verdict": "One-line verdict.",
  "items": [
    { "severity": "critical|important|minor",
      "file": "relative/path.ts", "line": 42,
      "claim": "One-sentence defect claim.",
      "evidence": "Why this is real and reachable.",
      "suggested_fix": "Concrete correction." }
  ]
}
```
````

Validation, hardened after review (review record finding 16):

- Parse **only the final exact marker**. A preamble before it is tolerated — models drift and add
  "Here is my analysis:". Trailing content *after* the appendix is not.
- A duplicate marker is `malformed`, not "take the last one silently".
- Cap appendix byte size and item count. Treat all appendix content as **untrusted input**.
- Validate `file` as repository-relative; reject absolute paths and traversal.
- JSON must be an object; `verdict` a non-empty string; `items` an array; each item a recognized
  `severity` and non-empty `claim`; `file`/`line`/`evidence`/`suggested_fix` may be null.
- **Truncated JSON is `malformed`.** Token truncation can leave the marker present and the JSON
  incomplete; reporting that as "no findings" for a diff with real defects is the failure mode that
  teaches users not to trust the tool.
- Carry a distinct **`findings_status: ok | absent | malformed`** — not merely `findings: null`, which
  cannot distinguish "the reviewer found nothing" from "the reviewer's output was unparseable".
- Invalid output **must not destroy the prose**: `result.md` is always returned.
- Classify the job as `protocol` only when strict structured output was explicitly required.

A corpus of real model outputs across all three backends is a checked-in test fixture from day one —
format stability is a claim that has to be measured, not assumed.

`access` for `review` is always `read-only`; a user override is rejected with exit `2`.

---

## 12. Isolation for `--mode implement`

> **Worktree isolation is repository-state isolation ONLY.** It prevents the backend from mutating the
> user's checkout. It does **not** prevent it reading credentials, SSH keys, or arbitrary user files —
> only the backend's own sandbox does that. Never document or imply otherwise, and scope
> `--access read-only` to what the wrapper can genuinely enforce (ADR-004 amendment).

**Wrapper-managed detached git worktrees**, not backend-native snapshots (ADR-004: this is a real
enforceable common invariant, so it belongs in core):

1. Resolve the repository and `HEAD`; record `base_commit`.
2. Create a detached worktree under `<state-root>/worktrees/<job-id>`.
3. Run the backend with the worktree as its canonical directory.
4. Reject nested repositories, unresolved conflicts, and path escapes.
5. On success, stage intended changes and create a wrapper-owned snapshot commit → `result_commit`.
   **Use git plumbing that bypasses hooks and signing**, with wrapper-controlled author metadata — a
   normal `git commit` can trigger the user's hooks or fail on unavailable signing/identity config.
6. `diff` compares `base_commit..result_commit`; `--stat` / `--name-only` size it first
   (mutually exclusive; both together exit `2`).
7. `apply` transports the recorded commit range into the main repository with rollback.

`apply` requires a clean main working tree; `--allow-untracked` is an opt-in override for unrelated
untracked files only. Tracked dirt, path overlap, or an in-progress am/rebase exit `2`. On conflict,
exit `25` **only after verifying** the main repo is restored with no residual git operation.
`apply --reset-author` / `--message` reauthor and retitle the single landed commit; on a resumed
multi-commit series both exit `2` up front, before the main repo is touched.

**`apply` must never run automatically** at any policy checkpoint. Inspect `diff` first.

opencode's native `/experimental/worktree` and `/vcs/apply` are captured as a namespaced extension
and used for diagnostics only — they have their own identity and lifecycle and would weaken the
wrapper's reproducibility and cleanup guarantees.

---

## 13. Deadlines — every blocking boundary is finite

| Boundary | Default |
|---|---|
| Worker startup sentinel | 30 s |
| Backend startup / no-first-event watchdog | 120 s |
| opencode server health-ready | 30 s |
| Job hard timeout | 1800 s, configurable, `0` disables |
| Post-exit stdout/stderr drain | 5 s |
| HTTP connect / read | 10 s / 60 s |
| SSE idle (no event, no keepalive) | 120 s |
| File-lock acquisition | 10 s |
| Individual git operation | bounded per call |
| `wait` caller budget | 300 s; `--timeout-sec` overrides without changing the job |
| `doctor` live smoke | 120 s |

Rules: drain child pipes **concurrently from launch** — never "wait for exit, then read stdout"
(a full pipe deadlocks). Bound maximum line size. Log malformed JSON lines; never make them fatal.
Every HTTP operation carries an `AbortController` deadline.

**The long-lived server's own output must also be drained** (review record finding 11). This was a gap:
concurrent draining was specified for short-lived children, but the per-job `opencode serve` process
outlives them all. An undrained pipe on a verbose server fills its buffer and **hangs the server** — a
never-hang violation inside the never-hang design. Server stdout/stderr is captured to a size-capped,
rotating job log and drained continuously for the entire server lifetime.

**Explicitly detect the study §5 hang class:** if a permission or question request is pending while
the session reports `busy` and no event has arrived within the watchdog window, that is
`permission_or_sandbox` / `blocked`, not `timeout`. Report it precisely.

---

## 14. Cancellation and process containment

**The ladder is declared by the adapter, not hardcoded by the engine** (ADR-007). A fixed four-rung
sequence in core is a backend-conditional in disguise: Codex has exactly one rung, opencode has three,
Claude with native agents bypassed has one.

```
write cancel.request (atomic)
  → for each rung the adapter declared, in order:
        RequestCancel(attempt, rung) ; bounded wait ; check postcondition
  → if no rung terminated it: hard process-tree kill via the contained job
  → verify all contained processes exited (identity + execution token, §below)
  → state = cancelled ; record which rung succeeded
```

Declared rungs, as of today:

| Backend | Rungs |
|---|---|
| opencode | `session_abort` → `server_dispose` → `hard_kill` |
| codex | `hard_kill` |
| claude | `hard_kill` (native-agent stop only if that extension is ever enabled) |

The shared promise is the **outcome** — "the job ceases running within bounded escalation" — never the
mechanism (ADR-004).

**Windows.** The native helper (ADR-003) creates the backend process before it can spawn
descendants, assigns it to a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and breakaway
disallowed, then resumes it. Wrapper death closes the handle and the kernel kills the tree.
If assignment fails (already in a non-breakaway job), fall back to verified descendant enumeration
plus `taskkill /T /F`, **record `containment.degraded = true`**, and test that path explicitly.

**Unix.** Start in a new process group; `SIGTERM` → grace → `SIGKILL` to the group.

**Never** kill by executable name or by an unverified reused pid. OS process identity is
`pid + creation time + image path` — but that only reduces PID-reuse mistakes, it does not *prove
ownership*. The helper generates a **random execution token** per job; the wrapper stores it and
verifies it before acting, using OS identity as corroboration only (ADR-008).

**Controller death terminates the job (ADR-008).** The helper is tied to the invoking controller.
Recovery marks the attempt `interrupted`; `resume` starts a **new attempt** from durable inputs and
never reattaches to a running backend. State this as a non-promise in user documentation:
*dcli does not promise continuation of running jobs across wrapper crashes.*

Containment failure is **fail-closed**: if containment is requested and the helper is missing or
version-incompatible, the job does not start. `taskkill`-based cleanup is a **declared degraded
capability** recorded in the job record — never a transparent fallback.

### Amendment 2026-08-02 — implementation status of this section

The containment contract remains binding, but production wiring is still incomplete. This is intentionally
recorded here so timeout and cancellation promises are not overstated:

- `ContainmentContext` (`core/containment.js`) is constructed nowhere in `core/`, `adapters/` or `cli/`.
  All three adapters launch the backend with a plain `child_process.spawn`, so no backend tree is in a Job
  Object, and `core/commands/cancel.js` passes `containment: null` hardcoded.
- Therefore the ladder's `→ if no rung terminated it: hard process-tree kill via the contained job` step, the
  `containment.degraded` record, and the fail-closed rule are all **specified but absent**.
- A Job Object cannot adopt an already-running tree, and the native helper's protocol has no
  terminate-by-pid command (only `spawn` and `terminate`, the latter acting solely on the Job Object that
  helper instance created). So the gap cannot be closed from the `cancel`/`worker` side — the tree must be
  contained at spawn time. That is **ticket 78**, blocked on the native helper's stdin/EOF protocol.
- Until then, the honest record is the contract: a hard timeout writes `kill_skipped: 'not_contained'` on the
  `timed_out` detail, and an all-rungs-failed cancel records `cancel_rung_reached: 'containment_unavailable'`
  rather than reusing the adapter rung name `hard_kill`. Neither ever reports a kill that did not happen.

---

## 15. Locking and concurrency

One lock per job, plus narrowly scoped locks for: job-id/index creation; worktree create/remove
within a repository; applying to the main repository; cleanup; per-job server lifecycle.

Windows: exclusive file handle, no sharing. Unix: advisory `flock` plus owner metadata.
Lock metadata records pid, process start time, hostname, operation, and acquisition time — a pid
alone is insufficient because of reuse.

Background jobs are **separate worker processes**. The top-level CLI never stays resident.

### Admission control

An engine-level admission controller (`core/admission.js`) bounds **global and per-backend concurrency**,
configurable. Fan-out multiplies model runtimes, file watchers, caches, provider connections, and memory —
not merely process count (both reviewers, review record finding 14). Ten small background tasks can become
ten servers plus ten agent processes and exhaust memory or provider quota before any timeout logic
helps. Jobs beyond the limit queue rather than launch, and `status` says so.

**Slot accounting.** Each running job occupies a durable slot file in `<state-root>/locks/admission/<uuid>.json`
containing the owner's pid, start time, hostname, execution token, backend, and acquisition time. Slot
files survive a controller crash.

**Queue.** Queued jobs are recorded in `<state-root>/queue/<job-id>.json`. When a slot is released,
`tryDequeue()` scans the queue, acquires slots for the oldest queued jobs, and removes them from the
queue.

**Reconciliation.** `reconcile()` scans slot files, checks owner pid liveness via `process.kill(pid, 0)`,
and removes stale entries. Called at controller startup and exposed for periodic use.

**Defaults.** Global limit: 5. Per-backend limit: 5 (configurable per backend in the CLI layer; CLI sets
`opencode: 3, codex: 3, claude: 3`). Measured, not assumed: `opencode serve` came up in ~2 s against
30–90 s model turns on the study host, so per-job server startup is not a latency concern at low
concurrency. Re-measure under realistic fan-out in the opencode adapter work before choosing final defaults.

---

## 16. Command surface

**Core** — identical wrapper-level contract on all three backends:

```
run submit status wait read list resume cancel tail diff apply
debug cleanup doctor capabilities
```

**Core options** — only genuinely stable concepts:

```
--repo <path>  --prompt-file <path>  --mode <m>  --access <a>
--hard-timeout-sec <n>  --group <g>  --label <l>  --model <id>  --json
```

`--model` is only *syntactically* shared: it means "this backend's model identifier". Model names do
not transfer between backends.

**Backend-qualified options** (ADR-004 — deliberately not unified):

```
dcli-codex --reasoning-effort none|low|medium|high|ultra
dcli-claude   --reasoning-effort low|medium|high|xhigh|max
dcli-opencode --variant <provider-specific string>
```

**Namespaced extensions:**

```
dcli-opencode permission list|reply       dcli-opencode question list|reply|reject
dcli-opencode session diff                dcli-opencode native-worktree ...
dcli-claude   native-agent ...            dcli-claude from-pr <n>
dcli-codex thread ...
```

Modes: `review`, `brainstorm`, `test`, `implement`.
Access: `read-only`, `workspace`. `review` is always `read-only`; `brainstorm`/`test` default to
`read-only` and require an explicit `--access workspace`; `implement` requires `workspace` but only
inside its worktree. No mode grants access outside the selected repository/worktree. Network policy
is separately configurable (`deny` | `ask` | `allow`).

For opencode, the wrapper generates a per-session permission ruleset per job (study §7) and must
never mutate the user's permanent opencode configuration.

Examples:

```powershell
"Compare these two designs." | dcli-opencode run --mode brainstorm
dcli-opencode review --working --path src/ --intent "Add cache invalidation" --embed-diff
"Run the full test suite." | dcli-claude submit --mode test --access workspace
dcli-opencode status <job-id> --json
dcli-opencode wait --all --group nightly --json
dcli-opencode resume <job-id> --prompt-file follow-up.md
dcli-opencode diff <job-id> --stat
dcli-opencode apply --reset-author --message "fix: ..." <job-id>
dcli backends --json
```

`wait --all --group <g> --json` is the fan-out/gather primitive; callers must never hand-roll
polling loops.

### `resume` is three distinct operations

The engine owns the `resume` command and job lineage, but backend continuation is not uniform. Never
label all three "resume" (review record finding 7):

| Kind | Meaning | Availability |
|---|---|---|
| `continue_backend_session` | Continue the same backend conversation | Needs a live, resumable backend session id |
| `fork_from_artifacts` | Branch from a recorded result — new backend session, seeded from the parent's artifacts / worktree commit | Always available |
| `retry_attempt` | Re-run the *same* request as a new attempt, after an `interrupted` or transient failure | Always available |

`resume` selects the kind explicitly, records it as `session_strategy`, and **never silently
substitutes one for another** — a `session_expired` failure must surface, not quietly become a fork.
After ADR-008, a controller crash always yields `retry_attempt` or `fork_from_artifacts`; a running
backend is never reattached.

Implementation follow-ups apply only the **newest accepted descendant**; never the ancestor.

---

## 17. Claude Code integration

Generated (ADR-001) from `integration/source/` + core command metadata + adapter capability
manifests + version warnings:

```
~/.claude/skills/{dcli-codex,dcli-opencode,dcli-claude,dcli}/SKILL.md
~/.claude/commands/{dcli-codex,dcli-opencode,dcli-claude}/{review,ask,implement,resume,jobs,doctor,cleanup}.md
~/.claude/rules/dcli-delegation.md
```

`dcli/SKILL.md` is a **router only**: choose a backend, then load that backend's skill. It
must not reproduce all three references.

Generation tests fail the build if: a public command lacks skill documentation; a capability is
documented but not declared; **an adapter's flag appears in another adapter's skill**; checked-in
generated files are stale; installed files do not byte-match repository outputs.

Each skill must teach: delegate only bounded, worthwhile work; use file/stdin-safe prompt transport;
prefer background submission for long tasks; **independently verify every finding**; never auto-apply;
inspect `diff` before `apply`; use exact wrapper lineage rather than "continue last session"; react
per the failure-class table; never retry quota/auth/permission/timeout failures; keep review intent
neutral; keep delegated work out of the caller's context until collection.

**Decided against: no project policy file.** An earlier draft of this section specified a
`.dcli/policy.json` with auto/ask/off delegation modes, inherited from the predecessor `ccodex`.
That is deliberately not built. Any auto/ask/off checkpoint implies a code path where some condition
triggers automation — and that is incompatible with AGENTS.md's "nine mistakes" #8: `apply` never
runs automatically, not at a policy checkpoint, not unattended, ever. See commit `074cdd0`, which
states the absence explicitly in every generated skill so an agent cannot infer a checkpoint exists.
There is no `.dcli/policy.json`, and none is planned.

---

## 18. Cross-platform requirements

Platform-native state/config discovery. Normalize paths without lowercasing case-sensitive Unix
paths; hash the platform-appropriate canonical form. **Never** build subprocesses through
`cmd.exe /c` or `/bin/sh -c` for ordinary invocation — use argument arrays; `command.txt` is quoted
for humans only. Handle executable suffixes and PATH lookup per platform. UTF-8 without BOM
everywhere; read child stdout as UTF-8 explicitly (study §4). Test spaces, non-ASCII, long paths,
UNC paths, symlinks, and junctions. Keep git behavior consistent under CRLF/LF and case-sensitive
repositories. Do not rely on WMI as a primary backend for process inspection.

---

## 18a. Windowless execution (Windows)

**Hard requirement:** no process the tool creates may ever put a window on the user''s desktop — not a flash,
not for a detached worker, not for a `.cmd` shim, not for the per-job backend server. A background delegation
tool that blinks console windows is unusable.

| Path | Mechanism |
|---|---|
| every `spawn` from Node | `windowsHide: true`, **explicitly, always** — never rely on console inheritance |
| the native containment helper | `CREATE_NO_WINDOW`; **never** `CREATE_NEW_CONSOLE`. Node''s option does not apply here — the helper creates the process itself, and this is the path where the predecessor''s bug lived |
| `.cmd` / `.bat` shims (codex, claude) | spawn `%ComSpec%` with `/d /s /c` and the pre-quoted inner line, itself windowless |
| anything | `shell: true` is banned (quoting **and** window semantics) |

**Do not assert on `conhost.exe`.** Measured on the study host: a child spawned *with* `windowsHide: true`
allocated its own `conhost.exe`, while the same child *without* it allocated none — because `CREATE_NO_WINDOW`
allocates a console *without a window*. A "no conhost descendant" assertion fails on the correct configuration
and passes on the wrong one.

**The verifiable property is window visibility.** Enumerate top-level windows, map each to its owning pid, keep
only visible ones, and assert that no pid in the job''s descendant set appears. The test must also prove the
detector works, by asserting it finds the desktop''s other windows.

Measured baseline on the study host (Node v24.18.0, parent both with and without an inherited console): no
tested combination of `windowsHide` and `detached` produced a visible window. That is the current state, not a
guarantee — the assertion above is what keeps it true.

Note this is about **window suppression**, not execution mode: `run` remains synchronous and `submit` remains
the detached form. Both spawn windowless children.
## 19. Secrets and redaction

Added after review (finding 10) — this was simply missing, and it is adjacent to a subsystem that
deliberately reads secret-bearing data: the failure classifier inspects provider error bodies (§8), and
provider error bodies are exactly where tokens live.

### Implementation (ticket 13)

`core/redactor.js` — `Redactor` class with two detection mechanisms:

1. **Registered exact values.** Secrets are registered by name and exact value at creation time
   via `registerSecret(name, value)`. The redactor searches for these exact byte sequences in
   text and replaces them with `«redacted:name»`.
2. **Key-name pattern matching.** As a backstop, values under known credential key names are
   automatically redacted: `authorization`, `api[-_]?key`, `token`, `secret`, `password`,
   `bearer`, `auth.json`. Matching is case-insensitive.

`redactText(text)` — plain-text replacement of registered exact values.
`redactValue(value)` — deep-walks objects/arrays, applying both exact-value replacement and
key-name pattern matching.
`redactJson(value)` — alias for `redactValue`, for JSON-serializable data.

**Integration.** The redactor is injected into the writer path via `core/fs-text.js`'s module-level
`setRedactor(redactor)`. Once set, `writeTextFileAtomic`, `writeJsonFileAtomic`, and `appendJsonLine`
automatically redact content before persistence. A call site cannot bypass it — every write goes through
the same path.

(2026-07-31) A `createSanitizingRedactor()` copy-for-export helper was specified here for a `--sanitize`
path that was never built, and is removed. Build it with the export path, not before it.

Rules:

- **Redact before persistence, not on read.** Redaction is in the writer path (`core/fs-text.js`),
  transparent to every caller. Once a token is on disk it is leaked.
- Redact in: environment snapshots, HTTP request/response bodies and headers, `backend-events.jsonl`,
  stdout/stderr logs, `debug.json`, `command.json`/`command.txt`, and the `doctor` envelope.
- **Never write at all:** the per-job server password, provider credentials, `Authorization` headers,
  `auth.json` contents, or any value sourced from a credential store. These are covered by the key-name
  pattern matcher. The per-job server secret is passed through the environment and never appears on a
  command line or in a normal log.
- The state root gets restrictive ACLs (owner-only) on creation via `ensureStateRoot()`. On Windows this
  uses `icacls /inheritance:r /grant <user>:(OI)(CI)F`; on Unix `chmod 700`. Tested.
- Prompts and results are user content, not secrets, and are persisted unredacted apart from any
  registered secret value that happens to appear inside them.
- A planted-token test registers a known secret, writes through every channel, and verifies the secret
  never reaches disk.

## 20. Open questions

Everything in study §11 remains open. Additionally:

1. Does `--port 0` reliably report the bound port, and from which stream?
2. Exact basic-auth mechanics for every endpoint used.
3. `directory`/`workspace` routing correctness per endpoint — verify effective project identity
   before prompting.
4. Whether SSE can miss events; what reconciliation is sufficient.
5. `PermissionRuleset` precedence/ordering/pattern semantics and `deny` behavior (study §11.1).
6. Claude Code's exact noninteractive permission behavior under `-p` — can it block like opencode?
7. Whether `claude --output-format stream-json` with `--input-format stream-json` offers a control
   channel for answering permissions (would make `dcli-claude` symmetric with `dcli-opencode`).
8. ~~Whether a Job Object can be attached before the Bun-built opencode binary spawns descendants,~~
   ~~and its breakaway behavior.~~
   **RESOLVED 2026-07-28 by experiment (ticket 06).** Yes to all four questions. See ADR-003
   second amendment and ticket 06 Notes.
9. Minimum/maximum supported version per backend, after compatibility testing.
10. Whether a per-job server materially costs anything under realistic fan-out.
