# 102 — Unix: contain the backend in its own process group, so cancel and hard timeout kill the tree

**Status:** ready
**Blocked by:** —
**Tier:** Trust. `--hard-timeout-sec` and `dcli cancel` currently reach the backend's *direct child only*.
On Unix the mechanism that fixes this is specified, unblocked, and costs one spawn option plus one signal
call — it has simply never been implemented. This is rung 1 of ADR-010's ladder, and it is a **full**
guarantee on its platform, not a degraded one.
**Filed from:** the containment review of 2026-08-10 that produced ADR-010.

---

## Symptom / Goal

All three adapters launch the backend with a plain `spawn` that does **not** set `detached`, and terminate
it with `child.kill('SIGKILL')` on the child's pid. On Unix that signals one process. Anything the backend
spawned — a language server, a test runner, a `git` subprocess, opencode's watchers and providers — is
reparented to init and keeps running.

So a `dcli cancel` that reports `cancel_rung_reached: 'hard_kill'` has, on Unix, killed one process and left
its descendants alive. The wrapper's own record is accurate about the *rung it walked*, but the rung's
postcondition ("the job ceases running") is not actually met.

Goal: on Unix, the backend starts in its own process group and is signalled as a group, so the ladder's
`hard_kill` rung means what §14 says it means.

## Root cause

The spawn options were written for Windows, where `detached` has different semantics and the intended
containment mechanism was always the Job Object helper (ADR-003). The Unix half of §14 — "Start in a new
process group; `SIGTERM` → grace → `SIGKILL` to the group" — was specified and never built, and ticket 78's
all-or-nothing framing hid the fact that it was never blocked on anything.

Verified at `adcbac1`:

```
adapters/claude/adapter.js:234    spawn(invocation.command, invocation.args, { cwd, stdio, windowsHide,
                                    windowsVerbatimArguments, env })   // no `detached`
adapters/codex/adapter.js:336     same shape
adapters/opencode/adapter.js:887  same shape

adapters/shared/process-lifecycle.js:121   this._childProcess.kill('SIGKILL');
adapters/claude/adapter.js:445             this._childProcess.kill('SIGKILL');
adapters/codex/adapter.js:567              this._childProcess.kill('SIGKILL');
adapters/opencode/adapter.js:1588          this._serverProcess.kill('SIGKILL');
```

`detached: true` appears only for dcli's **own** worker (`core/commands/submit.js`, `core/commands/worker.js`),
never for a backend.

## Binding constraints — quoted, do not go looking for them

From `docs/design-spec.md` §14:

> **Unix.** Start in a new process group; `SIGTERM` → grace → `SIGKILL` to the group.

> **Never** kill by executable name or by an unverified reused pid. OS process identity is
> `pid + creation time + image path` — but that only reduces PID-reuse mistakes, it does not *prove
> ownership*.

A process-group id **is** proof of ownership in a way a pid is not: the group was created by this spawn and
contains only its descendants. Say so in the code comment; a future reader will otherwise assume the "never
kill by unverified pid" rule forbids this.

From **ADR-010** (read it in full before starting — it is the reason this ticket exists and the reason it
stops where it stops):

> | 1 — process group (Unix) | `detached: true`, `SIGTERM` → grace → `SIGKILL` to the group | the group dies |
> `containment.kind: 'process-group'`, `degraded: false` |

> A rung may never report a kill it did not achieve.

From `docs/design-spec.md` §5, the `status.json` shape this ticket populates:

> `"containment": { "kind": "job-object", "handle_owner_pid": 1234, "degraded": false }`

`containment.kind` gains the value `process-group`. Invariant 4 is append-only: **adding a value to this
enum is allowed; changing the meaning of `job-object` or `degraded` is not.**

From `AGENTS.md`, invariant 1: no backend-specific conditional in `core/`. A **platform** conditional is not
a backend conditional — this one lives in the adapters' shared spawn/terminate code and branches on
`process.platform`, exactly as `docs/engineering/windows-spawning.md` already does elsewhere.

ADR-007 stands: the adapter still declares its rungs, the engine still walks them. This ticket changes what
`hard_kill` *does*, not who decides to walk it.

## Files to read and trace first

- `adapters/shared/process-lifecycle.js` — `applyProcessLifecycle`, and `RequestCancel`'s `hard_kill` branch
  at the `kill('SIGKILL')` call. This is the one place that can serve codex and claude at once.
- `adapters/claude/adapter.js` — the `spawn(...)` options object, and its own `kill('SIGKILL')` site.
- `adapters/codex/adapter.js` — the same two sites.
- `adapters/opencode/adapter.js` — the server `spawn(...)` and `_serverProcess.kill('SIGKILL')` in `Dispose`.
  Note that opencode's `hard_kill` is the **last** rung after `session_abort` and `server_dispose`; the two
  graceful rungs must keep working unchanged.
- `core/commands/worker.js` — the hard-timeout timer and `hardTimeoutKillSkipped = 'not_contained'`. The
  comment above it explains why the escalation is currently skipped; it must be updated to reflect that on
  Unix there is now a rung that terminates.
- `core/commands/cancel.js` — `containment: null` is hardcoded. Read what it feeds before deciding whether
  this ticket touches it (see Non-goals — it probably should not).
- `docs/engineering/windows-spawning.md` — read before touching any spawn option, even a Unix-only one.
- `tests/adapters/` and `tests/contract/suite.js` — the behaviour that must not move on Windows.

## What to build

### 1. Spawn the backend in its own process group on Unix

In each of the three adapters' spawn options:

```js
// POSIX only. `detached: true` calls setsid(2), putting the child in a new process group whose
// pgid is the child's pid, so every descendant it spawns is in that group and can be signalled
// as a unit. On Windows `detached` means a new console instead, which is not containment and
// would defeat windowsHide — see docs/engineering/windows-spawning.md.
detached: process.platform !== 'win32',
```

Do **not** call `child.unref()`. The child must stay refed; dcli waits on its exit.

### 2. Terminate the group, not the pid

Replace each `kill('SIGKILL')` with a shared helper — put it in
`adapters/shared/process-lifecycle.js` and have the opencode adapter import it too:

```js
terminateProcessTree(child, { graceMs }) -> Promise<{ kind, degraded, escalated }>
```

- **Unix:** `process.kill(-child.pid, 'SIGTERM')`; wait up to `graceMs`; if the child has not exited,
  `process.kill(-child.pid, 'SIGKILL')`. Returns `{ kind: 'process-group', degraded: false }`.
- **Windows:** unchanged — today's `child.kill('SIGKILL')` on the direct child, returning
  `{ kind: 'none', degraded: true }`. Ticket 103 raises this half.

`graceMs` has a finite default (invariant 3) and the grace wait is bounded. `ESRCH` from either signal means
the group is already gone — treat it as success, not as an error.

### 3. Record the rung honestly

`containment: { kind: 'process-group', degraded: false }` in the job record on Unix. On Windows the record is
unchanged, and `core/commands/worker.js` still writes `kill_skipped: 'not_contained'` — but **only on
Windows**. On Unix the hard timeout now escalates to a real group kill, so `kill_skipped` must not be
written there. Writing it after a successful kill is the inverse of the lie ADR-010 forbids and is just as
wrong.

### 4. Tests

- A fixture that spawns a grandchild and prints its pid; assert the grandchild is gone after the rung.
  `tests/fixtures/grandchild-pipe.js` is the existing precedent for a fixture of this shape.
- Grace-then-escalate: a fixture that ignores `SIGTERM`; assert it is gone after `graceMs`.
- Already-exited: terminating a dead group returns success and does not throw (`ESRCH`).
- The Windows path is unchanged, asserted where the suite already asserts it.

Unix-only tests must skip cleanly on Windows and **say they skipped** — see ticket 91, which established
exactly this discipline for the existing containment test. A silently-skipped test is a green suite that
proves nothing.

## Non-goals

- **Windows containment of any kind.** Rung 2 is ticket 103, rung 3 is closed (ticket 78). Mixing platforms
  here would make the diff unreviewable and put the untestable half in the way of the testable half.
- **Constructing `ContainmentContext` (`core/containment.js`).** That class is the Job Object helper client —
  rung 3. It has no Unix path and this ticket must not grow one into it.
- **Changing `core/commands/cancel.js`'s hardcoded `containment: null`.** That parameter exists for the
  helper handle. Rung 1 needs no handle: the adapter that owns the child owns the group. Leave it.
- **Adding or renaming a cancel rung.** ADR-007 says the adapter declares them; the declared lists do not
  change. `hard_kill` simply becomes able to keep its promise on one platform.
- **Making the Unix guarantee survive worker death.** That is kill-on-close, which only the Job Object gives.
  ADR-008's non-promise stands unchanged.

## Acceptance criteria

- [ ] **A.** All three adapters spawn the backend with `detached: true` on POSIX and `detached` unset (or
  false) on Windows. No `unref()` is called on a backend child.
- [ ] **B.** One shared `terminateProcessTree` helper is the only place a backend child is signalled; the
  four `kill('SIGKILL')` sites listed above are gone.
- [ ] **C.** On Unix, a test proves a **grandchild** of the backend is dead after the `hard_kill` rung.
- [ ] **D.** On Unix, `SIGTERM` is sent first and `SIGKILL` follows only after a finite grace; a fixture that
  ignores `SIGTERM` is still terminated, and the grace wait is bounded.
- [ ] **E.** On Unix the job record carries `containment: { kind: 'process-group', degraded: false }`, and a
  hard timeout that killed the group does **not** write `kill_skipped`.
- [ ] **F.** On Windows every behaviour is byte-identical to before: same spawn options, same
  `kill_skipped: 'not_contained'`, same records. `tests/contract/suite.js` passes unchanged.
- [ ] **G.** Unix-only tests skip explicitly and visibly on Windows (ticket 91's pattern), never silently.
- [ ] **H.** opencode's `session_abort` and `server_dispose` rungs still run first and still work.
- [ ] **Z.** `npm run check` green; `README.md`, `docs/design-spec.md` §14 and `integration/source/core.md`
  updated in the same commit — the README currently states the non-guarantee unconditionally and must now
  scope it to Windows.

## Agent checks

```bash
# The backend is detached on POSIX only.
grep -n "detached" adapters/*/adapter.js adapters/shared/process-lifecycle.js
# expect: `detached: process.platform !== 'win32'` (or equivalent) at each backend spawn; nothing else

# No backend child is signalled outside the shared helper.
grep -rn "kill('SIGKILL')\|kill(\"SIGKILL\")" adapters/
# expect: exactly one site, inside terminateProcessTree

# The child is not unref'd.
grep -rn "unref()" adapters/
# expect: nothing on a backend child

# No backend name leaked into core (invariant 1).
grep -rniE "codex|opencode|claude" core/containment.js core/commands/worker.js
# expect: nothing but backend-name-as-data

npm run check
# expect: green
```

## Handoff

**Extra reading, beyond `AGENTS.md` and `00-onboarding.md`** — **ADR-010** in
`docs/architecture-decisions.md` (the whole entry; it is why this ticket exists and where it stops),
`docs/design-spec.md` §14 including both amendments, `docs/engineering/windows-spawning.md`, and
**ticket 91's Notes** (`91-containment-test-headless-safe.md`) for how a platform-conditional containment
test is kept honest here. Nothing else.

**You are probably developing on Windows.** The primary target of this ticket is the platform you cannot
test on locally. That is the main risk. Handle it as follows and say in Notes which you did:

1. Write the Unix tests first and run them on a real POSIX host (WSL is acceptable and is the cheapest
   option; record the distro and Node version in Notes).
2. If you genuinely cannot reach a POSIX host, **stop and say so** rather than landing untested signal
   handling. An unverified `process.kill(-pgid)` is worse than the current honest rung 0.

**Implementation order:**

1. Write the grandchild-survival test (criterion C) against today's code on a POSIX host and **verify it
   fails**. Record its output in Notes — that failure is this ticket's evidence.
2. Add `terminateProcessTree` to `adapters/shared/process-lifecycle.js` with the Windows branch being
   today's behaviour **copied verbatim**. Point all four kill sites at it. Suite green, nothing changed yet.
3. Add `detached: process.platform !== 'win32'` to the three spawns. Suite green on Windows.
4. Implement the Unix group-signal branch with its bounded grace. The test from step 1 now passes.
5. Thread the `containment` record and the conditional `kill_skipped` through `core/commands/worker.js`.
6. Update `README.md`, §14 and `integration/source/core.md`, then re-run
   `node scripts/generate-integration.js` and confirm the generated skills are in the commit.

**Running tests while you work:**

```bash
node tests/contract/suite.js
node tests/adapters/observe-wakeup.test.js
npm run check
```

**Traps specific to this ticket:**

- **`process.kill(-pid)` is not `child.kill()`.** The negative pid signals the group and only works when the
  child was spawned `detached`. If `detached` is missing, `-pid` signals *dcli's own* group — which kills the
  worker, and possibly the user's shell. Guard on the platform and on having set `detached`, and never build
  the negative pid from a pid you did not spawn.
- **`detached` means something different on Windows** — a new console, not a new group. On Windows it would
  also defeat `windowsHide`. It must be POSIX-only, and `windowsHide` must stay exactly as it is.
- **Do not `unref()`.** dcli waits on the child's exit; unrefing it lets the worker exit mid-drain. The park
  timer comment in `process-lifecycle.js` explains the same hazard for the recheck timer.
- **`ESRCH` is success, not failure.** The group already being gone is the outcome you wanted.
- **The grace wait must be bounded** (invariant 3), and it must not block the fact stream.
- **Do not write `kill_skipped` after a kill that worked.** Reporting a skipped kill you did not skip is the
  same class of dishonesty as reporting a kill you did not perform.
- opencode's `hard_kill` is the third rung. Do not let this change short-circuit `session_abort` or
  `server_dispose` — a graceful abort is still preferred, and ADR-007 owns that order.

**Commit message:**

```
ticket 102: contain the backend in its own process group on unix
```

## Notes

(Left empty by the author.)
