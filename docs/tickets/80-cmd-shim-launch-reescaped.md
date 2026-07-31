# Ticket 80 — the `.cmd` shim launch path is re-escaped by Node, so the shim never runs

**Status:** landed 2026-07-31, in the same commit as ticket 79.
**Tier:** blocker — prerequisite for a trustworthy ticket 79 test

**Why it shares 79's commit, against the one-commit-per-ticket rule:** 79's regression test needs a `.cmd`
fixture that actually executes before it can assert anything about the child's real exit code, so 80 must
precede 79. But both fixes land in the same two functions of the same two adapter files, and splitting them
by hunk would mean committing an intermediate state whose tests were red. One commit, both tickets named,
recorded here rather than left for someone to infer from the diff.

---

## Symptom

`buildCmdInvocation` produces the correct pre-quoted cmd.exe command line, and then Node quotes it a
second time. cmd.exe receives literal backslash-escaped quote characters and treats the whole thing as
one program name:

```
args:   ["/d","/s","/c","\"C:\\...\\silent-then-exit.cmd --ephemeral -s read-only -\""]
exit:   1
stdout: ""
stderr: "'\"C:\\...\\silent-then-exit.cmd --ephemeral -s read-only -\"'
         is not recognized as an internal or external command..."
```

The target never runs. The launch *appears* to succeed — a child pid exists, no `EINVAL`, no throw —
which is why this survived.

## Root cause

`adapters/codex/cmd-quoting.js`, the `.cmd`/`.bat` branch, returns:

```js
return {
  command: comSpec,
  args: ['/d', '/s', '/c', '"' + escapedInner + '"'],
  ...
  windowsHide: true,
};
```

The inner line is deliberately hand-quoted, but the invocation carries **no
`windowsVerbatimArguments: true`**, so `child_process.spawn` applies its own Win32 quoting to that
already-quoted argument and escapes the embedded quotes.

AGENTS.md states the requirement verbatim under "Fact 2 — Node cannot spawn `.cmd` / `.bat` at all":
"the inner command line needs Win32 quoting *plus* force-quoting of cmd metacharacters, and **it must be
handed over as one pre-quoted string so the runtime does not re-escape it**." The pre-quoting was
implemented; the "do not re-escape it" half was not.

## Why nothing caught it

`tests/adapters/opencode/cmd-shim-spawn.test.js` asserts only that spawning a `.cmd` through
`buildCmdInvocation` **does not throw `EINVAL`**. It does not. It also does not run the shim. The test
passes on a launch path that cannot execute anything — a false green of exactly the shape AGENTS.md
records under "Test false greens are real and have shipped".

`tests/adapters/codex/cmd-quoting.test.js` only asserts the shape of the returned argv, never that the
argv works when handed to `spawn`.

## Why it is not the cause of the codex outage

Ticket 79's outage is a different defect. `resolveCodexPath` → `resolveVendorBinaryNear` finds the real
per-platform `codex.exe`, which takes the pass-through (non-shim) branch, so the real launch worked
(observed: a live codex pid, a real `backend_session_id`, a real version). This ticket is the **latent**
failure underneath: the moment vendor-binary resolution does not find an `.exe` and dcli falls back to
the npm `.cmd` shim, the backend silently never starts. AGENTS.md designates that fallback the main
path, not an edge case.

## Scope

One fix in `adapters/codex/cmd-quoting.js`, plus passing the flag through at all three spawn sites:

- `adapters/codex/adapter.js:~354`
- `adapters/claude/adapter.js:~233`
- `adapters/opencode/adapter.js:~818`

## Acceptance criteria

- [x] **A.** The `.cmd`/`.bat` branch of `buildCmdInvocation` carries `windowsVerbatimArguments: true`.
- [x] **B.** All three adapters pass it through to `spawn`. A site that builds an invocation and then
  drops one of its fields is the defect; pass the invocation's own value, never a re-typed literal.
- [x] **C.** The pass-through (`.exe`) branch does **not** set it — those args are a normal argv array
  and must keep Node's quoting.
- [x] **D.** A test spawns a real `.cmd` fixture through `buildCmdInvocation` and asserts the fixture
  **actually ran**: its own exit code and its own stdout marker. "Did not throw EINVAL" is not an
  acceptable assertion here — it is the assertion that hid this.
- [x] **E.** A test asserts each adapter's spawn site forwards the flag, so a future site cannot drop it.
- [x] **F.** `npm run check` green; docs updated in the same commit.

## Notes

- Do not switch to `shell: true`. It is banned for quoting reasons and changes window semantics
  (AGENTS.md, "No console window, ever").
- `windowsVerbatimArguments` means Node joins the args with single spaces and passes them through
  untouched. That is correct here precisely because `buildWin32CommandLine` + `quoteForCmd` have already
  done both quoting layers.
