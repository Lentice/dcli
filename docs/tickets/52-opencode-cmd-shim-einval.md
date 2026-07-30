# 52 — OpenCode server `spawn` of a `.cmd` shim throws EINVAL on Windows

**What to build:** the opencode adapter's per-job server can actually start when `opencode` is installed as an npm package, whose shim on Windows is a `.cmd` file that Node's `spawn` cannot launch directly (it throws `EINVAL` since Node 18.20/20.12). The codex and claude adapters already wrap `.cmd` shims through `cmd.exe /d /s /c` via `buildCmdInvocation` (see `adapters/codex/cmd-quoting.js`); opencode's server launch does not, so every `dcli-opencode` job on an npm-installed opencode dies at server start before its anti-hang window even opens.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `adapters/opencode/adapter.js` `Start` wraps the resolved `opencodePath` in `cmd.exe /d /s /c` whenever the path ends in `.cmd` or `.bat`, reusing `buildCmdInvocation` from `adapters/codex/cmd-quoting.js` (already shared with the codex/claude paths — do not fork a second quoting helper).
- [ ] The non-`.cmd` path (a real executable, e.g. the Bun-built single binary) is passed through unchanged — `buildCmdInvocation` already does this; confirm by reading its test at `tests/adapters/codex/cmd-quoting.test.js`.
- [ ] The server `spawn` still passes `windowsHide: true` explicitly and never uses `shell: true` (both are absolute rules in `AGENTS.md`).
- [ ] Test: when `resolveOpencodePath()` returns a path ending in `.cmd`, assert the argv handed to `spawn` is `['cmd.exe', '/d', '/s', '/c', '<quoted inner>']` and `windowsHide: true`, mirroring the codex/claude golden tests.
- [ ] Test: a real `.cmd` shim path spawns without `EINVAL` (use the fake adapter's mock server path or a stub `.cmd` created in a temp dir, spawned against a nonexistent port — assert no `EINVAL` synchronous throw).
- [ ] Full suite green.

## Development guidance

- The fix is a straight reuse of an existing, tested helper. Do NOT write new cmd-quoting in the opencode adapter — import `buildCmdInvocation` from `../codex/cmd-quoting` exactly as `adapters/claude/adapter.js:6` already does.
- `buildCmdInvocation({ command, args, env })` returns `{ command, args }` where, for a `.cmd`/`.bat` target, `command` becomes `process.env.ComSpec || 'cmd.exe'` and `args` becomes `['/d', '/s', '/c', <quoted full command line>]`. For any other extension it passes `command`/`args` through unchanged.
- The current broken code is `adapters/opencode/adapter.js:817`:
  ```js
  const server = spawn(opencodePath, args, { stdio: [...], env: {...}, windowsHide: true, cwd: ... });
  ```
  Replace with:
  ```js
  const invocation = buildCmdInvocation({ command: opencodePath, args });
  const server = spawn(invocation.command, invocation.args, { stdio: [...], env: {...}, windowsHide: true, cwd: ... });
  ```
- `core/child-process.js` `ManagedProcess` is a **test helper** used by the test suite for spawning; it’s not in the production adapter path. Do NOT change it — and do NOT file it as part of this defect (the codex/claude/cline adapters don’t use it in production either).
- The `env` you pass to `spawn` (`{ ...process.env, OPENCODE_SERVER_PASSWORD: this._password }`) is the **child environment**, not part of cmd-quoting. `buildCmdInvocation` does not consume `env`; pass it to `spawn` separately as today.
- Confirm `resolveOpencodePath()` and `resolvePastBunShim` still return the resolved path, not the raw `where opencode` output — wrapping in `buildCmdInvocation` is the fix, not changing the resolver. If `resolvePastBunShim` returns null and the fallback is a `.cmd`, that is exactly the case `buildCmdInvocation` was built to handle.

## Why it matters

OpenCode is the first-listed and most-used backend (project policy: backend order is opencode → codex → claude). On the single most common install path (npm install -g) it doesn’t start at all on Windows. The bug is silently swallowed by `Start`’s catch and the job ends `failed` with `failure_reason: null`, so the operator can’t tell whether the backend is broken or the wrapper is broken.

## How to verify

```powershell
node tests/run-tests.js --suite full
```
And run a live smoke: `dcli-opencode run "say hi" --hard-timeout-sec 60` on a machine where `where opencode` resolves to a `.cmd`. Before the fix: `EINVAL`. After: server up, turn done.

## Commit message

```
fix(opencode): wrap .cmd server shim in cmd.exe so spawn no longer throws EINVAL
```