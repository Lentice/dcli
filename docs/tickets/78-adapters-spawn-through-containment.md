# 78 — Containment is never used in production: adapters plain-`spawn` the backend, so no cancel rung and no hard timeout can ever kill the tree

**What to build:** the three adapters spawn the backend **through** a `ContainmentContext`, so the backend
tree is inside a Job Object from birth and `context.terminate()` provably kills it — including detached and
reparented grandchildren. This is not new architecture: it is what
[`docs/2026-07-28-design-spec.md`](../2026-07-28-design-spec.md) §14 (lines 620-624, 638-641) already
specifies and what ADR-003/ADR-008 assume. Today none of it runs.

**Blocked by:** native helper stdin forwarding and bounded EOF draining. The historical implementation ticket was
removed after archival; the prerequisite remains stated here because it is still a real protocol dependency.

**Status:** open

## What was found (verified 2026-07-31)

`ContainmentContext` is **dead code in production**. Nothing constructs it:

- `grep -rn "ContainmentContext" core adapters cli` → only its own definition in `core/containment.js:34`,
  plus a JSDoc mention in `core/cancel.js:29`. `core/commands/doctor.js` only checks whether the helper
  *file* exists.
- All three adapters spawn the backend directly, outside any Job Object:
  `adapters/claude/adapter.js:240`, `adapters/codex/adapter.js:354`, `adapters/opencode/adapter.js:824`.
- `core/commands/cancel.js:36` passes `containment: null` **hardcoded**. So `core/cancel.js`'s last-resort
  branch never had a containment object to call, on any real job.

Consequences, all of them real rather than theoretical:

1. **No cancel can guarantee termination.** When every adapter rung fails, nothing escalates. (The record
   used to say `cancel_rung_reached: 'hard_kill'` regardless — fixed in the ticket-69 honesty commit, which
   now records `containment_unavailable`.)
2. **The worker's hard timeout cannot kill anything**. It journals `timed_out` and exits, leaving
   the tree alive holding ports, temp dirs, locks and the stdout pipe.
3. **`containment.degraded` and the fail-closed rule in spec §638 are unimplemented.** A missing helper is
   not detected at job start; the job runs uncontained and nobody is told.

A pid-based tree kill is **not** an alternative. The native helper's protocol has exactly two commands,
`spawn` and `terminate` (`native/windows-job-helper/Program.cs`, the command switch), and `terminate` acts
only on the Job Object that helper instance created — `HandleTerminate` returns
`{"type":"error","error":"no active job"}` when `_jobHandle` is zero. A Windows Job Object cannot adopt an
already-running tree. See the note left in `core/containment.js` where the bogus `terminateTree` was removed.

## Why the native helper blocks this

The helper creates a stdin pipe for the child (`Program.cs:191`, `cStdinW`) but its main loop **discards
stdin-data messages** — the comment at `Program.cs:133` says so outright: `// ignore other types (e.g., stdin
data for child)`. Both the codex and claude adapters deliver the prompt through the child's stdin, so routing
them through the helper today would hang them with no way to send the prompt. Ticket 60 (helper stdin
forwarding and bounded EOF drain) must land first.

## Acceptance criteria

### A. Adapters spawn through containment
- [ ] Each adapter's `Start()` obtains a `ContainmentContext` and calls `context.spawn({args, cwd, env, stdio})`
      instead of `child_process.spawn`. The returned `{pid, executionToken, creationTime}` is what the wrapper
      persists as launch identity — **before** anything can lose it (AGENTS §5).
- [ ] The context is owned per attempt and closed in `Dispose()`, within the bounded adapter disposal path.
- [ ] No adapter retains a direct `spawn` of the backend. `grep -n "spawn(" adapters/*/adapter.js` shows no
      backend launch outside the containment path. (Auxiliary short-lived probes such as `DetectVersion` may
      stay direct — list any exception explicitly in the ticket Notes with its reason.)
- [ ] Invariant #1 holds: no backend conditional enters `core/`. The context is created by the same shared code
      for all three adapters.

### B. stdio through the helper
- [ ] stdout/stderr arrive as the helper's base64 NDJSON `{type:'stdout'|'stderr', data}` frames and are decoded
      as **UTF-8 explicitly** (AGENTS smaller rules — the console code page produced mojibake once already).
- [ ] Both output readers are armed **before** the prompt is written to stdin (AGENTS Mistake #2). The
      helper's frame demux must not require the child to drain stdin first.
- [ ] Raw helper frames never reach the parent's stdout; they land in `backend-events.jsonl`.
- [ ] `.cmd`/`.bat` shims still go through `cmd.exe /d /s /c <pre-quoted line>` — the helper's `CreateProcessW`
      has the same restriction Node does not paper over. `shell: true` stays banned.
- [ ] `CREATE_NO_WINDOW`, never `CREATE_NEW_CONSOLE`. Test **window visibility**, not `conhost` presence —
      per AGENTS, a correctly configured child *does* allocate a windowless `conhost`.

### C. Real termination
- [ ] `core/commands/cancel.js` passes the attempt's live `ContainmentContext` instead of `null`.
- [ ] `core/commands/worker.js`'s hard timeout, after the rung walk, calls `context.terminate({graceMs})` and
      records the outcome. `kill_skipped` is only written when there genuinely is no context, and its value
      then says why. This closes the current hard-timeout containment gap.
- [ ] `terminated: false` / non-empty `survivors` is reported as `termination_unconfirmed` and exit 21 — never
      as a clean kill. `tests/core/hard-kill-honesty.test.js` test 3 already pins this shape.
- [ ] Test: a backend whose child spawns a grandchild that outlives its parent — after `terminate()` the
      grandchild pid is gone. Assert against the exact pid set the test created, never a global count.

### D. Fail-closed and degraded capability (spec §638)
- [ ] Helper missing or version-incompatible → the job does **not** start; the failure is classified and
      observable (not `failure_reason: null`).
- [ ] If Job Object assignment fails because the process is already in a non-breakaway job, record
      `containment.degraded = true` and test that path explicitly. A degraded fallback is a **declared**
      capability in the job record, never a silent one.

### E. Docs in the same commit
- [ ] `docs/2026-07-28-design-spec.md` §14 gets a dated amendment recording that containment moved from
      specified-but-absent to implemented, and what `containment.degraded` means in the record.
- [ ] The design spec's hard-timeout amendment is updated in the same change.
- [ ] Full suite green; `npm run check` green.

## Development guidance

- Sequence: native helper stdin/EOF support → this ticket's part A/B on **one** adapter end to end (opencode is the hardest because
  of the server, codex the simplest — start with codex) → then the other two → then C/D.
- Watch the AGENTS §6 test-mode cliff: every adapter `Start()` opens with `if (this._testMode) {…; return}`.
  The containment path lives below that guard, so it needs tests that do **not** take the short-circuit.
  See `tests/adapters/*/start-*-scope.test.js` for the shape.
- Budget the process count. Ticket 77 measured 150-230 ms per process creation on this host, and this change
  adds a helper process per attempt. Prefer one context per attempt, and assert cleanup by exact path/pid.

## Why it matters

Every promise the tool makes about bounded termination currently rests on the adapter's own cooperation.
When a backend hangs in a way its rungs do not cover — the exact scenario behind AGENTS Mistake #1, where an
unbounded wait cost a user eight hours — dcli records a terminal state and walks away from a live process
tree. The Job Object is the only mechanism on Windows that makes the promise true rather than polite.

## How to verify

```powershell
node tests/run-tests.js --suite full
npm run check
```

## Commit message

```
feat(adapters,containment): backend trees are contained from birth, so cancel and hard timeout can prove termination
```
