# 31 — Call `adapter.Dispose()` on every terminal path

**Blocked by:** None — can start immediately
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` "The five invariants" #2,
[adapter-contract.md](../adapter-contract.md).

---

## Purpose

Every command that runs an attempt to completion (success, failure, timeout, or a result-collection error)
must call `adapter.Dispose(attempt)` exactly once, in a `finally`, before releasing admission capacity and
writing final terminal state.

## Why it matters

`Dispose()` is implemented on **all four adapters** (`fake`, `codex`, `opencode`, `claude`) but is **called
from nowhere in `core/`**. This is not backend-specific — it is a systemic gap.

## Evidence (verified live on this machine)

`grep -rn "\.Dispose(" core/ adapters/` finds `Dispose` *defined* in all four adapter files and never
*called* anywhere in `core/commands/*.js`.

Two concrete, reproduced leaks from this gap:

1. **OpenCode server leak.** `adapters/opencode/adapter.js` `Start()` spawns a real `opencode serve` child
   per job (not a one-shot). Running one job via `dcli-opencode run` and snapshotting `tasklist` before/
   during/after showed the spawned server PID (verified: PID 40768 in one run) **still alive after the CLI
   process had exited and printed its result.** It later self-terminated on an internal idle timeout, but
   for an unbounded window a real server process — holding a port, a generated password, and session state
   — outlives the job that owns it.
2. **Codex temp-directory leak.** `adapters/codex/adapter.js` creates a temp dir per attempt
   (`fs.mkdtempSync(... 'dcli-codex-')`) for the `--output-last-message` file. `Dispose()` is the only code
   that removes it (`fs.rmSync(this._tmpDirPath, ...)`), and since it's never called, **every single codex
   job leaves a temp directory behind.** Confirmed: 4 leftover `dcli-codex-*` directories in
   `%LOCALAPPDATA%\Temp` after 4 test runs, each containing the full result text.

## Design

- In each command that drives an attempt to a terminal outcome (`run`, `resume`, `review`, and any
  worktree/implement path), wrap the attempt body so `adapter.Dispose(attempt)` runs in a `finally` that
  covers: normal success, adapter/backend failure, hard timeout, and errors thrown during
  `CollectResult`/`CollectDiagnostics`.
- Bound the disposal call itself — `Dispose` must not be allowed to hang the command that's trying to
  finish. Give it a short, explicit timeout; if it doesn't return in time, proceed with terminal-state
  writing anyway and record that disposal didn't confirm (do not lose the job's actual result over a slow
  cleanup).
- After disposal, verify containment is empty (no descendant processes survive) before releasing admission
  capacity — releasing capacity while the old job's process/server is still alive would let a new job start
  while resources are still held.
- This should be one shared helper used by every command, not four copy-pasted `finally` blocks — but it's
  fine (and probably better) to land this as a single focused change across `run.js`, `resume.js`,
  `review.js` rather than a new abstraction if a shared helper doesn't already fit naturally.

## Pitfalls

- Do not call `Dispose()` synchronously inline without a bound — the OpenCode adapter's dispose path
  involves at least one HTTP/process operation that must itself be bounded (see ticket 07's pipe/drain
  rules).
- Do not release the admission slot before disposal completes or times out — this would let a new job
  start while the old backend process/server is still consuming the resource the slot represents.
- Do not regress `run`'s current text-returning behavior — disposal happens after `CollectResult`, not
  instead of it.

## Checklist

- [ ] `run`, `resume`, and `review` each call `adapter.Dispose(attempt)` in a `finally` covering success,
      failure, timeout, and result-collection-error paths.
- [ ] Disposal is bounded by an explicit timeout distinct from the job's hard timeout.
- [ ] Admission capacity is released only after disposal completes or its bound elapses.
- [ ] Regression test: run a real (or fixture) OpenCode-shaped job through the fake adapter with a
      simulated long-lived child, assert `Dispose` was invoked exactly once per attempt.
- [ ] Regression test: after a `codex`-shaped run using the fake adapter's temp-dir-creating path (or a
      dedicated fixture), assert the temp directory no longer exists after the command returns.
- [ ] Live verification note recorded: confirm no orphan `opencode.exe` (serve) process survives more than
      a few seconds after a `dcli-opencode run` completes.

## How to verify

```powershell
node tests/run-tests.js --suite full
echo "pong" | node cli/dcli-opencode.js run --repo . --hard-timeout-sec 60 --access read-only
# then, within a few seconds:
tasklist /FI "IMAGENAME eq opencode.exe"   # count must not have grown and stayed grown
```

## Definition of done

Full suite green; live verification shows no orphaned OpenCode server process and no leftover
`dcli-codex-*` temp directory after a normal run.

## Commit message

```
fix: dispose adapters on every terminal path to stop server and temp-dir leaks
```
