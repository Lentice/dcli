# 60 — Native Windows job helper forwards nothing to child stdin and stops pipe copy on `done` instead of EOF

**What to build:** the native containment helper (`native/windows-job-helper/Program.cs`) actually writes prompt bytes to the child's stdin pipe when `stdio == "pipe"`, and the stdout/stderr pipe copy threads drain to EOF (broken-pipe) rather than bailing the instant `done` is signalled — so a ~100 KB trailing stdout buffer (the documented review-diff size that triggers a backpressure race) isn't lost, and backends that read prompt-on-stdin (codex, claude) don't hang when the helper is the spawn path.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `stdio == "pipe"` actually delivers stdin bytes. The helper accepts a stdin-payload (via the IPC pair it already speaks to the controller) and `WriteFile`'s bytes to `cStdinW` BEFORE or WHILE the child runs, then closes `cStdinW` so the child sees EOF.
- [ ] `PipeCopyLoop` (around line 319-331) drains until `ReadFile` returns broken-pipe (child gone) AND `PeekNamedPipe` reports `avail == 0` — it does NOT exit the loop based solely on `done.WaitOne(0)`. The `done` signal can stop NEW writes to the child's stdin, but the stdout/stderr copy must drain buffered bytes the child already wrote.
- [ ] A test verifies that a child which writes 1 MB of stdout, then exits, then `done` is signalled immediately, delivers the full 1 MB to the controller — no truncation. (Without the fix, the pipe copy bails on `done` and drops trailing bytes.)
- [ ] A test verifies that a child which reads prompt-on-stdin, processes it, then writes a result, actually receives the prompt bytes when spawned via the helper (mock the controller side of the IPC pair or invoke the helper as a library).
- [ ] The `WaitForSingleObject(_childProcessHandle, INFINITE)` in `ChildWaitThread` (around line 276) is bounded — pass a finite timeout (e.g. `resolveDeadline`-equivalent or a hard-coded 30 minutes for the helper, with `WAIT_TIMEOUT` triggering a `TerminateProcess`). Invariant #3.
- [ ] `windowsHide`/`CREATE_NO_WINDOW` semantics preserved (don't introduce `CREATE_NEW_CONSOLE`).
- [ ] Full suite green.

## Development guidance

- The helper currently has no IPC for "send stdin bytes" — the controller spawns, gets a pid, and that's it. You'll need to add a small IPC for stdin payload: either a named pipe the controller writes to (and the helper forwards) or a temp file path passed via the spawn-args. The named pipe is cleaner and keeps the helper synchronous-preflight-free.
- The bug is the documented "drained to EOF" trap from `AGENTS.md` §3 ("A bounded tail that calls `readAllBytes` and then slices is not bounded. Seek, then read") and the "writes stdin then reads stdout deadlocks" from §2. Both are relevant: arm the readers BEFORE writing stdin (the helper already does), and drain to EOF (this ticket).
- The `done` event exists to signal "child exited" — useful to know when to stop waiting, NOT to stop reading. The里边 stdout/stderr copy is independent of child liveness; it must continue until the pipe is truly empty.
- Watch the `BUILD_COMMAND_LINE` quoting (`AGENTS.md` §"Fact 2" plus `core/cmd-quoting.js`s golden tests): if you add stdin bytes-passing via a file path in argv, that path needs Win32 quoting. Reuse `quoteForCmd` if the helper takes a string-form command line, or in the helper's C# code mirror the C logic in `adapters/codex/cmd-quoting.js`.
- If full stdin forwarding is too big a change in one ticket, split: this ticket covers (a) EOF drain (correctness) plus (b) at least a "stdin EOF immediately" stub so child readers see EOF, and a follow-up covers full byte forwarding. State the split in the ticket if you do this.

## Why it matters

The codex adapter is documented as "codex exec --json, prompt on stdin" — when (if) the helper becomes the spawn path for codex, this bug silent-hangs every codex job. The lost stdout half is the documented ~100 KB review-diff backpressure trigger (`AGENTS.md` §2). Both class of bug are on the documented expensive list.

## How to verify

```powershell
# Native helper tests are in tests/ — check the existing structure and add to it.
node tests/run-tests.js --suite full
```

## Commit message

```
fix(native): forward child stdin to EOF and drain stdout/stderr to broken-pipe, not on done
```