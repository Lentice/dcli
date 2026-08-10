# Lessons that cost the most

Read this when you are writing engine, adapter, or process-lifecycle code. Every entry was paid for by a
real bug, a real stall, or a real review finding — most in this project's predecessor `ccodex`, a
production tool that wrapped the Codex CLI for two months, and some in `dcli` itself.

The five invariants in `AGENTS.md` are the compressed form of the worst of these. This file is the
evidence behind them, and the detail you need when the invariant alone does not tell you what to do.

## 1. An unbounded wait cost a user eight hours

The worst incident in the predecessor's history: a delegated job stalled and consumed an entire working
session, because the *documented recipe* omitted a timeout. The backend had produced its result at
T+11.5 min; the process was still alive at T+8 h.

Two rules came out of it, and both are absolute:

- **Every documented recipe — README, skill, command, rule, example — carries an explicit execution
  budget and wait budget.** A recipe without one is a defect, even though it is "only docs".
- **Never trust a phase or a progress signal as a completion signal.** Poll state. A job holding a
  finished result while its process tree is alive is a real, observed condition.

## 2. "Write stdin, then read stdout" deadlocks

Arm both output readers *before* writing stdin. A child can fill an OS pipe before draining its own
stdin, deadlocking parent against child. It surfaces with a ~100 KB embedded review diff — which is the
*default* review path, so this is not an edge case.

Start the timeout deadline immediately after process start so a blocked write is inside the budget. On
teardown, preserve the order: close stdin → kill the contained tree → boundedly observe readers → flush
partial output → report.

## 3. Every drain must be bounded — this was fixed three separate times, then a fourth

The predecessor shipped three separate fixes for the same class: the normal-exit drain, the doctor
probe's drain, and the concurrent stdin/stdout drain. A "read until EOF" on a child's stream hangs
whenever a surviving grandchild holds it open.

Also: a "bounded tail" that calls `readAllBytes` and *then* slices is not bounded. Seek, then read.

**The fourth was in `dcli` itself (ticket 79), and it did not look like a drain bug.** The adapters' live
fact drain parked on `await new Promise(resolve => { this._liveFactsResolve = resolve })`, and the child's
`exit` handler woke a *different* waiter. A parked wait whose loop condition is only re-checked after it
settles is a hang the moment one wake-up path is missed — and a missed wake-up is one forgotten line, in a
handler nobody re-reads.

Two rules, and the second is the one that made this invisible for the whole build:

- **A wait must re-check its own condition on a bounded interval, not only when someone remembers to wake
  it.** Waking correctly is necessary; depending on it is not sufficient. A dropped wake-up must degrade
  to a short delay, never to a hang.
- **A bare promise refs nothing, so "await forever" is not a hang — it is a silent exit 0.** Once the
  child's pipes and `ProcessWrap` are released, no libuv handle remains, Node drains the event loop and
  the process exits **0, mid-`for await`**, with no result and no error. `dcli-codex run` returned exit 0
  with zero bytes on both streams for exactly this reason, and an agent parsing stdout reads that as
  "succeeded, empty result". Whatever holds a wait open must be a real refed handle, and if a comment
  claims a promise is "refed", that comment is wrong — the one in `_waitForExit` is why this defect read
  as already-considered.

## 4. Process trees do not die the way you expect

- **A parent pid is creation-time ancestry, not a dependency graph.** An observed process's parent was
  already gone while it still held blocking resources.
- `taskkill /T` does not reach detached or reparented descendants.
- Kill **innermost-first, re-snapshotting** between steps. Capture *all* launcher layers, including
  `cmd.exe` shims.
- Global process hunting by command line or handle table is **explicitly rejected** — bounded
  observation plus diagnostics is the safe fallback.
- Identity is `pid + creation time + image path`, plus a random execution token for proof of ownership.
  Never kill by image name; never trust a bare pid.

## 5. Launch identity must be persisted *before* it can be lost

A detached worker's identity held only in the launching process's memory produced two bugs at once: a
job permanently stuck in `created` (reconciliation had no identity to prove death), and a `cancel` that
wrote `cancelled` while killing nothing — leaving a live worker that later overwrote the record.

Persist launch identity durably the instant the process exists, distinct from ownership of the backend.

**Launch failure leaves orphans.** If the worker dies between spawn and the startup sentinel, something
may still be running. Detect and clean it up — never leave an untracked process holding a lock or a
worktree.

## 6. Validate before you convert, and before you mutate

Three separate bugs. A range check after a unit conversion overflows first. A bad `--repo` filter that
is validated after the sweep begins has already deleted something. A retention value of `0` wiped all
jobs.

Order is always: validate → convert → act. And reject valueless flags explicitly — `--model`,
`--effort`, `--message` all shipped bugs where a missing value was silently accepted.

## 7. A parse failure must never read as a clean result

The review findings appendix produced a whole family of bugs: a malformed appendix degraded into a clean
review; a single-element top-level array was mis-enumerated; a line number above int32 crashed the
parser; inline code fences broke segmentation.

Carry an explicit `findings_status: ok | absent | malformed`. `null` alone cannot distinguish "found
nothing" from "unparseable", and reporting the second as the first teaches users to distrust the tool.

Related and just as bad: **silent truncation**. The predecessor's embedded diff truncated at 100 KB
without saying so, meaning a review could silently cover only part of a change. And review selection
built from `git diff` never saw untracked files, so a review of brand-new files could report "clean"
**without having read them**. If coverage is reduced, say so in the output.

## 8. Snapshot and apply are where data gets destroyed

- A synthetic commit that runs the user's git hooks can hang forever, or fail on unavailable signing.
  Use plumbing that bypasses hooks and signing, with wrapper-controlled author metadata, and bound it.
- Rollback must not `reset --hard` over changes it cannot prove it owns. Re-check the tree immediately
  before restoring; if unexpected modifications appeared, **skip the reset and report non-restoration**
  rather than discarding a user's work.
- Refuse `diff`/`apply` when snapshot finalization failed — do not offer a partial artifact.
- Take a per-main-repo lock for `apply`, and hold a lease for the whole of `diff`/`apply`/`resume`.
  Retention cleanup once deleted a worktree mid-operation, destroying the only artifact needed to retry.
- **`apply` never runs automatically.** Not at a policy checkpoint, not unattended, ever.

## 9. The installer can delete everything

`Copy-Item -Recurse -Force` over an existing install *merges*, so a module deleted in a newer version
survives as a stale file. Stage the new tree and swap it in whole.

And it needs refusal guards: a review found that pointing the install directory at the wrong place made
the script directory the job-state root, and the mirror then **deleted all job state**. Refuse an install
directory that collides with the state root, and refuse to replace a non-empty directory lacking the
tool's marker file.

---

## Smaller rules that still bite

- **UTF-8 without BOM** for everything the tool writes, through the shared writer only. Decode child
  stdout as UTF-8 **explicitly** — relying on the console code page produced mojibake in the opencode study.
- **Raw backend events never reach the parent's stdout.** They go to `backend-events.jsonl`. Tests assert
  stdout byte-exactness, because agents parse it.
- **Reconciliation must preserve** `failure_reason` and `backend_session_id`. A past bug dropped both.
- **A 0-byte result is "empty", not a crash** — classify it, don't throw.
- **Don't over-count on failure.** A sweep counter incremented before a removal that failed reported work
  it had not done.
- **Reject ignored flags and positionals** rather than silently discarding them.
- **Argument order matters for real CLIs.** The predecessor had to fix exec-level options being placed
  after a subcommand token. Build argv deliberately and golden-test it.
- **Resolve executables to the executable form.** npm installs both `.cmd` and `.ps1`; PowerShell ranks
  the script higher and `Process.Start` cannot run a `.ps1`.
- **Never scrape a human log for a machine value.** Specifically the bound port. If no machine-readable
  handshake exists, reserve-and-retry and *test the race*.
- **Bound the process-creation call itself.** A wedged process-creation provider hung `submit` *before*
  its anti-hang window began, because the deadline only started after creation returned.
- **Startup sentinels need slack and a fast-fail.** A too-tight sentinel flaked under load; the fix was a
  wider window, an environment override, **and** a dead-worker fast-fail so a real failure is not slow.
- **Redact before persistence, never on read.** The failure classifier deliberately reads provider error
  bodies, which is exactly where tokens live.
- **Watch startup cost.** The predecessor eagerly loaded every module on every invocation, ~380 ms on
  every command including `--help`. Dispatch help before heavyweight imports; measure before and after.

Spawning processes without putting a window on the user's desktop has its own file:
[`windows-spawning.md`](windows-spawning.md).
