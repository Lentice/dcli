# 00 — Onboarding: read this once before any ticket

Read `AGENTS.md` (it loads automatically), then **this file**, then **your one ticket file**, and you
have everything you need. Do not read the other tickets, and do not read the wider `docs/` tree unless
your ticket names it.

This file holds only what `AGENTS.md` does not: the backend version pins, the job model, the exit codes,
and the two facts the whole design is built on. The invariants, conventions, commit rules and
stop-and-ask list are in `AGENTS.md` and are not repeated here.

## 1. The backends

| Shim command | Backend CLI | How it is driven |
|---|---|---|
| `dcli-opencode` | opencode `>=1.18.0 <1.19.0` (studied on 1.18.7; verified live on 1.18.10–1.18.12) | one `opencode serve` process **per job**, over HTTP |
| `dcli-codex` | codex-cli 0.145.0 | `codex exec --json`, prompt on stdin |
| `dcli-claude` | Claude Code 2.1.220 | `claude -p --output-format stream-json` |

Typical uses: a second opinion on a design; a scoped code review whose diff never enters the user's own
context window; a long task run in the background; a code change made in an isolated worktree that the
user reviews before applying.

## 2. Job state, in one picture

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
  starts a **new attempt**. This is a deliberate non-promise: *dcli does not promise continuation of
  running jobs across wrapper crashes.*
- `status.json` is written atomically with a bounded retry on the concurrent-reader window, and
  reconciliation must *preserve* `failure_reason` and `backend_session_id`.

## 3. Exit codes you will need

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

## 4. The two facts that shaped the whole design

**Fact 1 — headless `opencode run` hangs forever, silently, on an `ask` permission.** Verified: zero
bytes on stdout, no event, no marker, still running after 120 s. Its only CLI escape is the
process-global `--auto`, which opencode's own help labels `(dangerous!)`. This is why the opencode
backend is HTTP, not CLI.

**Fact 2 — `opencode serve` exposes a 162-path OpenAPI 3.1 surface**, including a per-session
permission ruleset (verified to defeat Fact 1), endpoints to observe *and answer* pending permissions
and questions, a real `idle`/`busy`/`retry` status, and graceful session abort. That is what makes a
no-hang guarantee achievable.

## 5. How to work your ticket

1. Read `AGENTS.md`, then this file, then your ticket. Read only the extra documents your ticket names.
2. Check your ticket's row in [`README.md`](README.md) for blockers — if those are not done, stop and say so.
3. Write the tests from the acceptance criteria first. Verify they fail.
4. Implement.
5. Run the full suite. Run your ticket's Agent checks. Update the docs your ticket names.
6. Commit with the message in your ticket.
7. If you discovered something that contradicts these docs, **write it into the ticket's Notes section
   and say so in your report.** Undocumented discoveries are how this project rots.

If a test of yours conflicts with a rule in [`../engineering/lessons.md`](../engineering/lessons.md),
**the rule is right and your change is wrong** — every entry there is a bug that already shipped once.
