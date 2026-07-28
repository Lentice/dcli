# 06 — Process containment + the Job-Object-on-Bun experiment

**Blocked by:** 05
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md) §7 pitfall 3, `AGENTS.md` §4,
[ADR-003](../2026-07-28-architecture-decisions.md#adr-003) and
[ADR-008](../2026-07-28-architecture-decisions.md#adr-008).

---

## Purpose

When a job is killed — or when the controlling process dies — every descendant dies with it, provably.

This ticket also runs the **one experiment that confirms or reverses the language decision**, so it comes
before any adapter work.

## Why it matters

The predecessor's worst operational failure was a process tree that outlived its job by eight hours. What
was learned:

- `taskkill /T` does not reach detached or reparented descendants.
- A parent pid is creation-time ancestry, **not** a dependency graph — an observed process's parent was
  already gone while it still held blocking resources.
- Global process hunting by command line or handle table is **explicitly rejected** as unsafe.
- The only reliable answer on Windows is a kernel-enforced Job Object with kill-on-close.

And the reason this is a *gating* experiment: the whole "plain Node plus a tiny helper" language choice
rests on it. If a Job Object cannot be attached to the Bun-built `opencode` binary before it spawns
descendants, the containment guarantee is not real and the correct answer is **pure Go**.

## Step 1 — run the experiment first

Before writing production code, answer these and record the answers in the ADRs:

1. Can `opencode serve` be created suspended (or otherwise before it can spawn children), assigned to a
   Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and breakaway disallowed, then resumed?
2. Do its grandchildren (provider subprocesses, watchers, shells) end up inside the job?
3. When the handle-holding process is killed with no cleanup opportunity, does the kernel kill the tree?
4. Does opencode ever create a process with `CREATE_BREAKAWAY_FROM_JOB`?

**If (1)–(3) do not hold: stop. Do not ship a guarantee that does not hold.** Reverse ADR-003 to pure Go,
write that decision down, and re-scope this ticket.

## Design

### The native helper — deliberately tiny

Versioned primitives only:

```
spawn-contained { argv, cwd, env, stdio } → { pid, execution_token, creation_time }
terminate { execution_token, grace_ms }   → { terminated: bool, survivors: [] }
(lifecycle notifications on a pipe)
```

**Banned inside the helper**, and this list is enforced at review: telemetry, path resolution, string
manipulation, business logic, process-tree introspection, timeout decisions, cancellation-rung decisions,
job state, any backend knowledge. Node remains the sole state machine.

The feature-creep path is predictable — "while we're here, expose the tree as JSON", "add event-id kill
verification" — each addition ten lines and independently reasonable, and after five the project has a
real native addon with its own multi-platform build pipeline and two implementations to debug. Any
expansion is a design-review item.

### Windowless creation — the helper''s responsibility

Node''s `windowsHide` does not apply to processes the helper creates itself. The helper must pass
**`CREATE_NO_WINDOW`** and must **never** pass `CREATE_NEW_CONSOLE`. This is the exact path where the
predecessor''s "console window flashes on every background job" bug lived, because its production detach used
`Win32_Process.Create`, which gives a console app a new console by default.

Do **not** assert "no `conhost.exe` descendant" — measured on this host, the *correctly hidden* child allocated
a conhost and the unhidden one did not, because `CREATE_NO_WINDOW` allocates a console without a window. Assert
**window visibility** instead: enumerate top-level windows, map each to its owning pid via
`GetWindowThreadProcessId`, filter by `IsWindowVisible`, and assert no descendant pid appears. Prove the
detector works in the same test by asserting it finds the desktop''s other windows.
### Fail-closed

If containment is requested and the helper is missing or version-incompatible, **the job does not start**.
`taskkill`-based cleanup is a *declared degraded capability* recorded as `containment.degraded` — never a
transparent fallback. When degraded, kill innermost-first and re-snapshot between steps.

### Unix

Start the backend in a new process group; `SIGTERM` → grace → `SIGKILL` to the group.

## Checklist

- [ ] The four experiment questions are answered and recorded in the ADRs.
- [ ] If the experiment failed, ADR-003 is reversed to Go and this ticket is re-scoped (stop here).
- [ ] Helper exposes only `spawn-contained`, `terminate`, and lifecycle notifications.
- [ ] Helper contains none of the banned concerns; a review note in the ticket Notes confirms it.
- [ ] Helper binaries ship per architecture with hashes and a compatibility handshake.
- [ ] Containment is **fail-closed**: missing or incompatible helper prevents job start.
- [ ] `containment.degraded` is recorded when the fallback is used; a test exercises the fallback path.
- [ ] Degraded kill is innermost-first with re-snapshotting between steps.
- [ ] Grandchild-kill test: a child-of-a-child is dead after `terminate`.
- [ ] **Controller-death test:** the controlling process is killed with no cleanup opportunity; the tree
      dies and the attempt becomes `interrupted`.
- [ ] The helper passes `CREATE_NO_WINDOW` and never `CREATE_NEW_CONSOLE`.
- [ ] **Visible-window test:** no descendant pid of a job owns a visible top-level window, and the detector is
      proven working by finding the desktop''s other windows in the same test.
- [ ] The visible-window test runs for both a console-parent and a console-less-parent launch.- [ ] Unix process-group test: `SIGTERM` then `SIGKILL` reaches the whole group.
- [ ] Detached workers do not flash a console window on Windows.
- [ ] The process-creation call itself is inside the launch deadline — a wedged creation provider must not
      hang before the anti-hang window begins.
- [ ] Every hang-shaped fixture tree is terminated and **verified** in a `finally`.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

Manually, the decisive check: start a job, note the backend pid, kill the controlling process with
`Stop-Process -Force`, wait, then confirm no descendant survives and the job reads `interrupted`.

## Definition of done

The experiment is recorded, the grandchild and controller-death tests pass, and the degraded path marks
itself.

## Commit message

```
feat: kernel-enforced process containment with fail-closed native helper
```

## Notes

Record the experiment results here in full — they are load-bearing for ADR-003.
