# Spawning processes on Windows

Read this before writing or changing any code that creates a process. Two of the facts below are
counter-intuitive enough that the obvious implementation is wrong and still looks like it works.

## No console window, ever

**Requirement:** no process this tool creates may ever put a window on the user's desktop. Not a flash,
not for a moment, not for a detached background worker, not for a `.cmd` shim, not for the per-job
backend server. The predecessor needed a dedicated fix for exactly this, and a background tool that
blinks windows is unusable.

1. **Every** `spawn` passes `windowsHide: true` explicitly. Never rely on console inheritance — the
   wrapper is invoked from terminals, from an IDE, from a GUI-launched agent, and from its own detached
   workers, and the inherited-console situation differs in each.
2. The **native containment helper creates processes itself**, so `windowsHide` does not apply to it. It
   must pass `CREATE_NO_WINDOW` and must **never** pass `CREATE_NEW_CONSOLE`. This is the one path Node
   does not control, and it is where the predecessor's bug actually lived (its production detach used
   `Win32_Process.Create`, which creates a new console for a console app by default).
3. Never use `shell: true`. It is already banned for quoting reasons; it also changes window semantics.

**The production detach path and the test detach path will differ, so test both.** The predecessor used
CIM `Win32_Process.Create` in production for breakaway and `Start-Process` in tests for environment
inheritance — a bug in either one is invisible from the other.

## Fact 1 — `conhost.exe` is not the signal

Measured on this host: a child spawned **with** `windowsHide: true` allocated its own `conhost.exe`,
while the same child **without** it allocated none. That is not a regression — `CREATE_NO_WINDOW`
allocates a console *without a window*. Asserting "no conhost descendant" would fail on the correct
configuration and pass on the wrong one.

**Test window visibility, not conhost.** Enumerate top-level windows, map each to its owning pid
(`EnumWindows` + `GetWindowThreadProcessId` + `IsWindowVisible`), and assert no pid in the job's
descendant set owns a visible window. Verify the detector itself works by asserting it finds the
desktop's other windows.

## Fact 2 — Node cannot spawn `.cmd` / `.bat` at all

Since the Node 18.20 / 20.12 security fix, `spawn("foo.cmd", …)` fails with **`EINVAL`**. Verified on
Node v24.18.0 here. Both `codex` and `claude` are npm-installed and expose `.cmd` shims on Windows, so
this is on the main path, not an edge case.

The only correct form is to spawn the interpreter explicitly:

```js
spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", innerCommandLine],
  { windowsHide: true, windowsVerbatimArguments: true })
```

`shell: true` would also work and is **banned**. This is why the two-layered quoting rule exists: the
inner command line needs Win32 quoting *plus* force-quoting of cmd metacharacters, and it must be handed
over as one pre-quoted string so the runtime does not re-escape it.

**`windowsVerbatimArguments: true` is the half that makes "does not re-escape it" true, and omitting it
is not a style choice — it silently breaks the launch.** Ticket 80: the pre-quoting was implemented, the
flag was not, so `spawn` applied a third quoting layer, cmd.exe received literal `\"` characters and
reported the whole command line as an unrecognized program name. **The shim never ran, and the launch
still looked successful from the parent** — a live pid, no throw, no `EINVAL`.

That last sentence is also the testing rule: **assert the child's own observable behaviour — its stdout
marker and its exit code — never that `spawn` didn't throw.** "Does not throw `EINVAL`" is satisfied by a
launch that executes nothing, and that assertion is exactly what kept this green.
