# 00 — Onboarding: read this once before any ticket

Every ticket in this directory is written to be picked up cold. Read **this file** plus **your one
ticket file**, and you have everything you need. You do not need to read the other tickets, and you
should not read the whole `docs/` tree unless your ticket tells you to.

---

## 1. What this project is

`delegate-cli` lets an engineer working inside **Claude Code** hand bounded work to a *different*
coding-agent CLI and get a durable, inspectable result back. Three backends:

| Shim command | Backend CLI | How it is driven |
|---|---|---|
| `copencode` | opencode 1.18.7 | one `opencode serve` process **per job**, over HTTP |
| `ccodex` | codex-cli 0.145.0 | `codex exec --json`, prompt on stdin |
| `cclaude` | Claude Code 2.1.220 | `claude -p --output-format stream-json` |

Plus an umbrella `delegate --backend <b> ...` for scripting.

Typical uses: a second opinion on a design; a scoped code review whose diff never enters the user's own
context window; a long task run in the background; a code change made in an isolated worktree that the
user reviews before applying.

**Nothing is ever applied to the user's repository automatically.**

## 2. The shape of the code

```
cli/          shims: ccodex, copencode, cclaude, delegate
core/         the shared job engine — knows NOTHING about any backend
adapters/     codex/ opencode/ claude/ — the only backend-aware code
native/       tiny prebuilt Windows process-containment helper
integration/  source/ → generated/ Claude skills, commands, rules
tests/        core/ contract/ adapters/ integration/ fixtures/
docs/         specs, ADRs, CLI references, these tickets
```

## 3. The five invariants — violating any of these is a bug, not a tradeoff

1. **No backend-specific conditional may appear in `core/`.** No `if (backend === 'opencode')`, ever.
   If your ticket seems to require one, the abstraction is wrong — stop and fix the contract.
2. **Adapters emit *facts*; the engine decides state.** An adapter never says "the job is done". It
   says "the process exited", "the backend reports idle", "assistant text was produced". One
   engine-owned reducer turns facts into state.
3. **Nothing blocks forever.** Every wait, read, lock, HTTP call, and drain has a finite default. A new
   `await` without a deadline is a defect.
4. **Contracts are append-only.** Never rename or repurpose an exit code or a `status.json` field.
   Installed Claude skills read them.
5. **Backend-specific data lives only in `status.json.backend_state`**, which carries its own
   `schema_version`. Never add a top-level field whose meaning depends on the backend.

## 4. Job state, in one picture

```
<state-root>/jobs/<repo-key>/<job-id>/
├── status.json      PROJECTION. Atomically replaced. Safe for concurrent readers.
├── journal.jsonl    AUTHORITATIVE. Append-only lifecycle/attempt events.
└── attempts/<n>/    prompt.md, command.json, result.md, findings.json,
                     backend-events.jsonl, stdout.log, stderr.log, worker.log,
                     worker-started.json, worker-complete.json
```

- A job has one or more **attempts**. Resume and retry create a *new* attempt and never overwrite a
  previous one's pid, session id, logs, failure, or result.
- **States:** `created` → `running` → `done` | `failed` | `timed_out` | `cancelled` | `interrupted`.
- **`phase` is progress information only.** It is NOT a terminal signal. A job can hold a finished
  result while its process tree is still alive — this was observed live, a Codex job sat in
  `finalizing` for 14+ minutes because a helper subprocess never exited. Key off `state`.
- `interrupted` means the controlling process died. Recovery never reattaches to a running backend; it
  starts a **new attempt**. This is a deliberate non-promise: *delegate-cli does not promise
  continuation of running jobs across wrapper crashes.*

## 5. Exit codes you will need

| Code | Meaning |
|---:|---|
| `0` | success |
| `2` | usage/validation error, incl. unsupported option. **No job created.** `--json` must further distinguish `usage_error` from `unsupported_capability`. |
| `3` | job not found |
| `4` | job not terminal |
| `10` | backend execution failed |
| `11` | no usable result |
| `12` | environment/compatibility failure |
| `13` auth · `14` quota · `15` permission · `16` network | classified failures |
| `17` | lock / corrupt state |
| `18` | worker launch failure |
| `20` | caller's `wait` timed out (job still active) |
| `21` | cancellation unconfirmed |
| `22` | session missing/expired |
| `23` | repo/worktree preparation failure |
| `24` | job hard timeout (tree killed) |
| `25` | apply conflict (main repo verified restored) |
| `26` | backend protocol incompatible/malformed |

## 6. The two facts that shaped the whole design

**Fact 1 — headless `opencode run` hangs forever, silently, on an `ask` permission.** Verified: zero
bytes on stdout, no event, no marker, still running after 120 s. Its only CLI escape is the
process-global `--auto`, which opencode's own help labels `(dangerous!)`. This is why the opencode
backend is HTTP, not CLI.

**Fact 2 — `opencode serve` exposes a 162-path OpenAPI 3.1 surface**, including a per-session
permission ruleset (verified to defeat Fact 1), endpoints to observe *and answer* pending permissions
and questions, a real `idle`/`busy`/`retry` status, and graceful session abort. That is what makes a
no-hang guarantee achievable.

## 7. Pitfalls that have already cost real debugging time

These come from the predecessor tool (`ccodex`). Each was a real bug. If a test of yours conflicts with
one of these, **the test is right and your change is wrong.**

1. **Never "write stdin, then read stdout."** Arm both output readers *before* writing stdin. A child
   can fill an OS pipe before draining its own stdin, deadlocking parent against child. It shows up with
   a ~100 KB embedded review diff — which is the *default* review path.
2. **Bound the post-exit drain.** A normally-exited child can leave a stream open via a surviving
   grandchild; draining "until EOF" hangs.
3. **Process identity is `pid + creation time + image path`** — plus a random execution token for proof
   of ownership. Never kill by image name. Never trust a bare pid.
4. **`status.json` is written atomically with a bounded retry** on the concurrent-reader window, and
   reconciliation must *preserve* `failure_reason` and `backend_session_id` (a past bug dropped them).
5. **Raw backend events never reach the parent's stdout.** They go to `backend-events.jsonl`. Tests
   assert stdout is byte-exact — agents parse it.
6. **UTF-8 without BOM for everything the tool writes**, and decode child stdout as UTF-8 *explicitly*.
   Relying on the console code page produced mojibake in the opencode study.
7. **Validate ranges before converting or mutating.** Three separate bugs came from converting first.
8. **Resolve executables to the executable form.** npm installs both `.cmd` and `.ps1`; PowerShell
   ranks the script higher and `Process.Start` cannot run a `.ps1`.
9. **The installer mirrors, never merges** — a renamed module otherwise survives upgrades as a stale
   file. And it needs refusal guards: a mis-pointed install directory once deleted all job state.

## 8. Conventions

- **Plain JavaScript on Node.js, no build step.** JSDoc + `checkJs` for development-time typing.
  Explicit validators at every protocol boundary. `AbortController` on every HTTP call.
- **Argument arrays, never shell strings.** No `cmd.exe /c`, no `/bin/sh -c` for ordinary invocation.
  `command.txt` is quoted for humans and never executed.
- **Tests are plain assertion scripts checked by exit code** — no test-runner framework. Run the quick
  suite while iterating; the **full suite must be green** before a ticket is done.
- **One commit per ticket**, TDD order: write failing tests → verify red → implement → verify green →
  full suite → commit. **No co-author trailers.**
- **Docs are updated in the same commit** as the behavior they describe.

## 9. How to work your ticket

1. Read this file, then your ticket file. Read only the extra documents your ticket names.
2. Check your ticket's **Blocked by** — if those are not done, stop and say so.
3. Write the tests from the Checklist first. Verify they fail.
4. Implement.
5. Run the full suite. Update the docs your ticket names.
6. Commit with the message in your ticket.
7. If you discovered something that contradicts these docs, **write it down in the ticket's Notes
   section and say so in your report.** Undocumented discoveries are how this project rots.

## 10. When to stop and ask

Stop and report rather than guessing if:

- Satisfying your ticket appears to require a backend conditional in `core/`.
- A verified fact in your ticket turns out to be wrong on your machine.
- An acceptance criterion is impossible as written.
- You would need to change an exit code or a `status.json` field's meaning.
