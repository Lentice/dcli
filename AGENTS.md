# Repository guidelines — dcli

**Read this file before writing any code in this repository.** It is short on purpose. Everything in
it was paid for by a real bug, a real stall, or a real review finding in this project's predecessor
(`ccodex`, a complete production tool that wrapped the Codex CLI for two months). Repeating these
mistakes is avoidable, and this file is how you avoid them.

If you are picking up a single ticket, read [`docs/tickets/00-onboarding.md`](docs/tickets/00-onboarding.md)
and your ticket file. This file is the standing rules that apply to every ticket.

---

## What this is

`dcli` lets an engineer in Claude Code delegate bounded work to a *different* coding-agent CLI
and get a durable, inspectable result back. Three backends behind three shim commands:
`dcli-opencode` (opencode), `dcli-codex` (Codex CLI), `dcli-claude` (Claude Code), plus `dcli --backend <b>`.

**Status:** design complete, no code written. Start at [`docs/tickets/`](docs/tickets/).

## Where to read what

`README.md` is **user-facing only**. Never use it as a technical source when developing.

| When you need | Read |
|---|---|
| To pick up one unit of work | `docs/tickets/00-onboarding.md` + your ticket |
| Why the architecture is the way it is | `docs/2026-07-28-architecture-decisions.md` |
| What was challenged and what changed | `docs/2026-07-28-architecture-review-record.md` |
| Binding contracts: job state, exit codes, adapter interface, deadlines | `docs/2026-07-28-design-spec.md` |
| Product intent and user stories | `docs/2026-07-28-spec.md` |
| Development pitfalls, testing strategy, phase order | `docs/2026-07-28-development-guide.md` |
| Exactly what a backend CLI accepts | `docs/reference/cli-{opencode,codex,claude}.md` |
| Verified facts about opencode, and what is still unverified | `docs/2026-07-28-opencode-cli-study.md` |

Dated amendment sections are authoritative where they refine earlier text.

---

## The five invariants

Violating any of these is a bug, not a tradeoff.

1. **No backend-specific conditional in `core/`.** If your work seems to need one, the abstraction is
   wrong — stop and fix the contract, don't add the branch.
2. **Adapters emit facts; the engine decides state.** An adapter never declares a job finished.
3. **Nothing blocks forever.** Every wait, read, lock, HTTP call, and drain has a finite default.
4. **Contracts are append-only.** Never rename or repurpose an exit code or a `status.json` field.
5. **Backend-specific data lives only in `status.json.backend_state`**, with its own `schema_version`.

---

## The nine mistakes that cost the most, in order

### 1. An unbounded wait cost a user eight hours

The worst incident in the predecessor's history: a delegated job stalled and consumed an entire working
session, because the *documented recipe* omitted a timeout. The backend had produced its result at
T+11.5 min; the process was still alive at T+8 h.

Two rules came out of it, and both are absolute:

- **Every documented recipe — README, skill, command, rule, example — carries an explicit execution
  budget and wait budget.** A recipe without one is a defect, even though it is "only docs".
- **Never trust a phase or a progress signal as a completion signal.** Poll state. A job holding a
  finished result while its process tree is alive is a real, observed condition.

### 2. "Write stdin, then read stdout" deadlocks

Arm both output readers *before* writing stdin. A child can fill an OS pipe before draining its own
stdin, deadlocking parent against child. It surfaces with a ~100 KB embedded review diff — which is the
*default* review path, so this is not an edge case.

Start the timeout deadline immediately after process start so a blocked write is inside the budget. On
teardown, preserve the order: close stdin → kill the contained tree → boundedly observe readers → flush
partial output → report.

### 3. Every drain must be bounded — this was fixed three separate times, then a fourth

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

### 4. Process trees do not die the way you expect

- **A parent pid is creation-time ancestry, not a dependency graph.** An observed process's parent was
  already gone while it still held blocking resources.
- `taskkill /T` does not reach detached or reparented descendants.
- Kill **innermost-first, re-snapshotting** between steps. Capture *all* launcher layers, including
  `cmd.exe` shims.
- Global process hunting by command line or handle table is **explicitly rejected** — bounded
  observation plus diagnostics is the safe fallback.
- Identity is `pid + creation time + image path`, plus a random execution token for proof of ownership.
  Never kill by image name; never trust a bare pid.

### 5. Launch identity must be persisted *before* it can be lost

A detached worker's identity held only in the launching process's memory produced two bugs at once: a
job permanently stuck in `created` (reconciliation had no identity to prove death), and a `cancel` that
wrote `cancelled` while killing nothing — leaving a live worker that later overwrote the record.

Persist launch identity durably the instant the process exists, distinct from ownership of the backend.

### 6. Validate before you convert, and before you mutate

Three separate bugs. A range check after a unit conversion overflows first. A bad `--repo` filter that
is validated after the sweep begins has already deleted something. A retention value of `0` wiped all
jobs.

Order is always: validate → convert → act. And reject valueless flags explicitly — `--model`,
`--effort`, `--message` all shipped bugs where a missing value was silently accepted.

### 7. A parse failure must never read as a clean result

The review findings appendix produced a whole family of bugs: a malformed appendix degraded into a clean
review; a single-element top-level array was mis-enumerated; a line number above int32 crashed the
parser; inline code fences broke segmentation.

Carry an explicit `findings_status: ok | absent | malformed`. `null` alone cannot distinguish "found
nothing" from "unparseable", and reporting the second as the first teaches users to distrust the tool.

Related and just as bad: **silent truncation**. The predecessor's embedded diff truncated at 100 KB
without saying so, meaning a review could silently cover only part of a change. And review selection
built from `git diff` never saw untracked files, so a review of brand-new files could report "clean"
**without having read them**. If coverage is reduced, say so in the output.

### 8. Snapshot and apply are where data gets destroyed

- A synthetic commit that runs the user's git hooks can hang forever, or fail on unavailable signing.
  Use plumbing that bypasses hooks and signing, with wrapper-controlled author metadata, and bound it.
- Rollback must not `reset --hard` over changes it cannot prove it owns. Re-check the tree immediately
  before restoring; if unexpected modifications appeared, **skip the reset and report non-restoration**
  rather than discarding a user's work.
- Refuse `diff`/`apply` when snapshot finalization failed — do not offer a partial artifact.
- Take a per-main-repo lock for `apply`, and hold a lease for the whole of `diff`/`apply`/`resume`.
  Retention cleanup once deleted a worktree mid-operation, destroying the only artifact needed to retry.
- **`apply` never runs automatically.** Not at a policy checkpoint, not unattended, ever.

### 9. The installer can delete everything

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
- **Hide console windows for detached workers** on Windows, or every background job flashes a window.
- **Bound the process-creation call itself.** A wedged process-creation provider hung `submit` *before*
  its anti-hang window began, because the deadline only started after creation returned.
- **Startup sentinels need slack and a fast-fail.** A too-tight sentinel flaked under load; the fix was a
  wider window, an environment override, **and** a dead-worker fast-fail so a real failure is not slow.
- **Redact before persistence, never on read.** The failure classifier deliberately reads provider error
  bodies, which is exactly where tokens live.
- **Watch startup cost.** The predecessor eagerly loaded every module on every invocation, ~380 ms on
  every command including `--help`. Dispatch help before heavyweight imports; measure before and after.

## No console window, ever — and two facts that make it non-obvious

**Requirement:** no process this tool creates may ever put a window on the user''s desktop. Not a flash, not
for a moment, not for a detached background worker, not for a `.cmd` shim, not for the per-job backend server.
The predecessor needed a dedicated fix for exactly this ("hide console windows for detached workers and codex
children"), and a background tool that blinks windows is unusable.

Rules:

1. **Every** `spawn` passes `windowsHide: true` explicitly. Never rely on console inheritance — the wrapper is
   invoked from terminals, from an IDE, from a GUI-launched agent, and from its own detached workers, and the
   inherited-console situation differs in each.
2. The **native containment helper creates processes itself**, so `windowsHide` does not apply to it. It must
   pass `CREATE_NO_WINDOW` and must **never** pass `CREATE_NEW_CONSOLE`. This is the one path Node does not
   control, and it is where the predecessor''s bug actually lived (its production detach used
   `Win32_Process.Create`, which creates a new console for a console app by default).
3. Never use `shell: true`. It is already banned for quoting reasons; it also changes window semantics.

### Fact 1 — `conhost.exe` is not the signal

Measured on this host: a child spawned **with** `windowsHide: true` allocated its own `conhost.exe`, while the
same child **without** it allocated none. That is not a regression — `CREATE_NO_WINDOW` allocates a console
*without a window*. Asserting "no conhost descendant" would fail on the correct configuration and pass on the
wrong one.

**Test window visibility, not conhost.** Enumerate top-level windows, map each to its owning pid
(`EnumWindows` + `GetWindowThreadProcessId` + `IsWindowVisible`), and assert no pid in the job''s descendant set
owns a visible window. Verify the detector itself works by asserting it finds the desktop''s other windows.

### Fact 2 — Node cannot spawn `.cmd` / `.bat` at all

Since the Node 18.20 / 20.12 security fix, `spawn("foo.cmd", …)` fails with **`EINVAL`**. Verified on Node
v24.18.0 here. Both `codex` and `claude` are npm-installed and expose `.cmd` shims on Windows, so this is on the
main path, not an edge case.

The only correct form is to spawn the interpreter explicitly:

```js
spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", innerCommandLine],
  { windowsHide: true, windowsVerbatimArguments: true })
```

`shell: true` would also work and is **banned**. This is why the two-layered quoting rule exists: the inner
command line needs Win32 quoting *plus* force-quoting of cmd metacharacters, and it must be handed over as one
pre-quoted string so the runtime does not re-escape it.

**`windowsVerbatimArguments: true` is the half that makes "does not re-escape it" true, and omitting it is not
a style choice — it silently breaks the launch.** Ticket 80: the pre-quoting was implemented, the flag was not,
so `spawn` applied a third quoting layer, cmd.exe received literal `\"` characters and reported the whole
command line as an unrecognized program name. **The shim never ran, and the launch still looked successful from
the parent** — a live pid, no throw, no `EINVAL`.

That last sentence is also the testing rule: **assert the child's own observable behaviour — its stdout marker
and its exit code — never that `spawn` didn't throw.** "Does not throw `EINVAL`" is satisfied by a launch that
executes nothing, and that assertion is exactly what kept this green.
## Names are contracts (ADR-009)

The family is **`dcli`**: umbrella `dcli`, shims `dcli-codex` / `dcli-opencode` / `dcli-claude`, state root
`dcli`, policy `.dcli/policy.json`, marker `<!-- dcli:findings -->`, environment prefix `DCLI_`, and
`status.json.backend` values `codex` / `opencode` / `claude`.

- **The predecessor `ccodex` is untouchable.** It is installed, working, and stays that way for the whole
  build. Never install over its command, skill, commands, rule, or state root. The failure this prevents is
  invisible: skill installation and `PATH` resolution select independently, so an agent can read one
  generation''s instructions while running the other generation''s binary, and the call still looks valid.
- **Every identifier above is persisted, parsed, or discovered by path — so it is already a contract.** Only
  help text and display names are soft. Never reuse a stable identifier for a new meaning.
- **`backend` values are opaque adapter IDs owned by us**, not vendor names. Need richer identity? Add a
  field; never change the enum.
- **Environment variables have declared classes.** Runtime `DCLI_WORKER` / `DCLI_DEPTH` / `DCLI_STATE_ROOT` /
  `DCLI_BACKEND` / `DCLI_JOB_ID`; test-only `DCLI_TEST_*`. **A test-only variable must never become an
  undocumented production override just because production code happens to read it.** Prefer argument
  injection over an environment knob — every knob is a process-global hidden input.
- `OPENCODE_SERVER_PASSWORD` is **not ours to name** — opencode requires it. Generate per job, keep it in
  memory only long enough to build the child environment, never mirror it into a `DCLI_*` variable, and redact
  it everywhere.
## Testing rules learned the hard way

- **Test false greens are real and have shipped.** A whole commit was needed to fix tests that passed
  while asserting nothing. Prefer assertions on observable artifacts: exit code, byte-exact stdout, and
  on-disk job state.
- **A mocked-out path is an uncovered path, and no test count reveals it.** Every adapter's `Start()`
  opens with `if (this._testMode) { …; return }`. Because every adapter test set `_testMode`, the 80–110
  real lines below that guard were executed by *nothing* — which is how a `ReferenceError: child is not
  defined` shipped in the codex adapter and broke **every** codex job while 16 adapter tests stayed green.
  **Every branch a test-mode short-circuit skips needs at least one test that does not take the
  short-circuit.** See `tests/adapters/*/start-*-scope.test.js` for the shape. This generalizes beyond
  `_testMode`: any mock, stub, or injected override draws the same cliff.
- **Never assert only that something threw.** `assert.ok(err, 'must fail')` is satisfied by a crash in
  our own code — that bare assertion was the *sole* reason the codex temp-dir test passed, and it hid the
  bug above for two commits. Assert the failure's identity: `exitCode`, `code`, `failureClass`, or a
  message match, and explicitly reject `ReferenceError`/`TypeError`, which are programmer errors wearing
  the costume of the failure under test. Use `tests/helpers/assert-failure.js`.
- **Never leave a hang-shaped fixture process alive.** Terminate and *verify* fixture trees in a `finally`.
  A leaked fixture poisons every later test on the machine. Choose the fixture binary deliberately:
  `cmd.exe` given unrecognized switches becomes an *interactive shell that never exits*, which silently
  waited out opencode's entire 30 s startup sentinel. `process.execPath` with a bad script argument dies
  immediately, which is usually what a "backend died at startup" test actually wants.
- **Never assert a delta against shared global state.** The runner executes files concurrently, so a
  count of `dcli-*` entries in `os.tmpdir()` includes other tests' directories: two leak tests running
  together produced `Before: 17, after: 16`. Assert against the exact path or id the code under test
  created.
- **Synchronize on observed state, not sleeps.** Fixed `sleep` delays make suites slow and load-flaky; use
  ready/release markers.
- Fault injection comes **before** broad feature tests. Kill the controller at each defined crash point
  and assert the job is terminal or `interrupted` — never stuck `running`, never orphaned.
- The quick suite must **name** what it skipped. A silently shrinking suite is how coverage rots.
- The **full suite must be green** before anything is declared done or committed.

## Documentation maintenance

A change is not done until the docs reflect it, **in the same commit** — never as a deferred task:

- `README.md` — user-facing usage and features.
- `docs/reference/*` — command/flag reference and contract tables.
- `integration/source/*` — whenever a command, flag, or behavior changes that an agent should know.
  Generated skills are checked in; CI must fail on staleness and on **one adapter's flag appearing in
  another adapter's skill**.
- Re-run the installer after user-facing changes and verify installed copies **byte-match** the repo.

Stale integration sources mean every future agent session is taught the old behavior. That is the most
expensive kind of doc rot in this project, because it is invisible.

## The lint gate

`npm run check` = `npm run lint` + the full suite. Both must be green before a commit.

`eslint.config.js` is **deliberately narrow** and exists for one class of defect: syntactically valid
code that references a name which does not exist at runtime (`no-undef`). That class is invisible to
`node --check` and invisible to the suite whenever the path is mocked out, and it broke every codex job
once already.

- **Keep it green.** A permanently-red lint run is decoration, and nobody reads decoration. Adding a rule
  is a real decision: it must pass across the whole repo **in the same commit that enables it**.
- **Rules that are off say why, inline.** `no-fallthrough` and `no-unused-vars` are currently `'off'` with
  their violation counts and reasons recorded in the config. Do not silently drop a rule, and do not
  enable one red.
- Full `tsc --checkJs` is **not** used: it reports 20+ implicit-any errors in a single adapter file, and
  that signal-to-noise ratio guarantees nobody looks.

## Git

One commit per ticket. TDD order: write failing tests → verify red → implement → verify green → lint +
full suite → commit. **No co-author trailers.** Never commit agent scratch directories.

## Dogfooding

After each phase, run a scoped second-opinion review of that phase's diff. On the predecessor this
repeatedly found real defects internal review missed — including the installer bug in §9 above. Triage
every finding explicitly: adopt with action, or reject with a stated reason. Never present a delegated
review's raw output as your own conclusion.

## When to stop and ask

- Satisfying a ticket appears to require a backend conditional in `core/`.
- A documented "verified" fact turns out to be false on your machine.
- You would need to change an exit code or a `status.json` field's meaning.
- An acceptance criterion is impossible as written.

Write what you discovered into the ticket's Notes section and say so in your report. Undocumented
discoveries are how this project rots.
