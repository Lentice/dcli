# 117 — version and doctor probes execute interpolated shell strings instead of argument arrays

**Status:** done
**Blocked by:** —
**Tier:** The repository rule is "argument arrays, never shell strings" at every process
boundary; the probes are the one place that still interpolates executable paths into `execSync`
command strings — including embedding them in `cmd.exe /d /s /c` for `.cmd` shims. A custom
executable path containing quoting/metacharacters is misparsed, and these probes are a trust
boundary: they run at setup, install verification and `doctor`.
**Filed from:** 2026-08-11 dual-backend audit (codex F-9)

---

## Symptom / Goal

The version/detection probes build shell strings:

- `adapters/opencode/adapter.js:206` — `` execSync(`"${opencodePath}" --version`) ``, and
  `:717` — same, in `--json` form.
- `adapters/codex/adapter.js:222-227` — `` `"${codexPath}" --version` `` with a
  `ComSpec /d /s /c` wrap for `.cmd`; `:565-585` — the `--version` and `doctor --json` probes.
- `adapters/claude/adapter.js:117-122` — same shape; `:432-437` — the live smoke probe.

The normal launch path already builds a proper invocation (`adapters/codex/cmd-quoting.js`:
`quoteForCmd` / `buildWin32CommandLine`; each adapter's `PrepareInvocation` seam). The probes
bypass it.

## Root cause

Detection and doctor predate the quoting seam and were never migrated.

## Binding constraints — quoted, do not go looking for them

`AGENTS.md`: "**Argument arrays, never shell strings.** No `cmd.exe /c`, no `/bin/sh -c` for
ordinary invocation, and never `shell: true`."

`AGENTS.md`: "Every wait, read, lock, HTTP call, and drain has a finite default." — the probes
already carry finite timeouts (`timeout: 10000`, `LIVE_SMOKE_TIMEOUT_MS`, `effectiveTimeout`);
keep them.

## Files to read and trace first

- `adapters/codex/cmd-quoting.js` — `quoteForCmd`, `buildWin32CommandLine`, `CMD_METACHARS`:
  the existing safe builders the launch path uses.
- Each probe site listed above, plus `adapters/shared/resolve-executable.js:59-60` (where the
  env-var path enters — the fix is at the probe sites, not here).
- How the launch path invokes `.cmd` shims (the `PrepareInvocation`/spawn options) so the probes
  mirror the same argument construction exactly.

## What to build

1. **Replace every probe with `spawnSync`/`execFileSync` over an argument array.**
   - Non-`.cmd` executables: `spawnSync(path, ['--version'], { encoding: 'utf8', timeout,
   windowsHide: true })` (or `execFileSync`), never a joined string.
   - `.cmd` shims on Windows: keep using `ComSpec` (`cmd.exe /d /s /c`) **but** pass the command
     line built by `buildWin32CommandLine(path, ['--version'])` as a single argument (an
     argument-array construction, the same shape the launch path uses), never a hand-interpolated
     string.
   - Keep every probe's existing timeout and `windowsHide`.
2. **Preserve exit-code/error handling.** The probes currently read exit status from the command
   result; `spawnSync` reports it via `status`/`error` — translate equivalently so detection and
   `doctor` verdicts do not change.
3. **Tests.** A probe test asserting that a path containing a space and a quoting metacharacter
   (e.g. `C:\Program Files (x86)\my tool&go.cmd`) resolves to the same version string as the
   plain path, on the current platform's `.cmd`/non-`.cmd` branch. If the existing adapter tests
   have a probe harness, extend it.

## Non-goals

- **No change to `resolve-executable.js`** or to which env vars are honored.
- **No change to probe timeouts or results** — only the invocation construction.
- **No `shell: true` anywhere** — the point of the ticket.

## Acceptance criteria

- [ ] **A.** No `execSync` with an interpolated string remains in `adapters/` (grep proof).
- [ ] **B.** `.cmd` probes go through the shared `buildWin32CommandLine` construction, and
  non-`.cmd` probes use argument arrays with `spawnSync`/`execFileSync`.
- [ ] **C.** Detection and `doctor` verdicts are unchanged for a plain path (existing tests
  green); a metacharacter-containing path is probed correctly.
- [ ] **Z.** `npm run check` green; the tracker table regenerated.

## Agent checks

```bash
# What this proves: no shell-string probes remain.
rg -n "execSync|spawnSync" adapters/
# expect: every hit passes an argument array (or the ComSpec single-argument construction);
#         no site builds a command string by concatenating the executable path

# What this proves: the metacharacter path is covered.
npm test -- --grep "probe|version"   # expect: green, including the quoting-metachar case
```

## Notes

Implemented by ticket 117 work. **What and where:**
- New `adapters/shared/run-probe.js` — `runProbe(command, args, timeoutMs)`: a single
  synchronous probe runner used by all three adapters. Non-`.cmd` executables spawn directly as
  an argument array (`spawnSync`); `.cmd`/`.bat` shims go through `cmd.exe /d /s /c` with the
  inner command line built by the shared `buildWin32CommandLine` and passed as one `/c` argument
  (wrapped in one outer quote pair, `windowsVerbatimArguments: true`), never by interpolating the
  path into a shell string. Keeps every probe's existing timeout and `windowsHide`. Throws on
  spawn failure or non-zero exit, so detection/doctor verdicts are unchanged.
- `adapters/codex/adapter.js` — `DetectVersion` (`--version`), `LiveSmoke` probes 1 (`--version`)
  and 2 (`doctor --json`) converted to `runProbe`.
- `adapters/claude/adapter.js` — `DetectVersion` and `LiveSmoke` converted.
- `adapters/opencode/adapter.js` — `DetectVersion`, `LiveSmoke`, and the remaining
  `execSync('bun pm bin -g')` site in `resolvePastBunShim` converted to
  `runProbe('bun', ['pm', 'bin', '-g'], 5000)`. The bun probe is not a version/doctor probe, but
  it was the last `execSync` shell-string site in `adapters/`; converting it makes the grep proof
  for criterion A airtight (zero `execSync` left in `adapters/`). No change to
  `resolve-executable.js` or env-var handling (non-goal honored).
- Tests: `tests/fixtures/version-shim.js` gained `writeVersionShimAt(filePath, version)`; each of
  `tests/adapters/{codex,claude,opencode}/adapter.test.js` gained a "DetectVersion probes a
  metacharacter-containing path" test that places the shim at
  `<tmp>/Program Files (x86)/my tool/version&go.cmd` (spaces + `&` + parens) and asserts
  `DetectVersion()` returns the same version as the plain-path test. On POSIX the same test uses
  a non-`.cmd` executable script with the same metacharacters in its path, covering the
  `spawnSync`-direct branch.

**Discovery that contradicts the ticket's "same shape the launch path uses":** `buildCmdInvocation`
(the launch path's helper) does not work for a metacharacter-containing `.cmd` path. It runs
`quoteForCmd` over the whole Win32 command line, which prefixes `^` to every `& ( )` — including
inside the double-quoted shim path. cmd.exe treats `^` inside quotes as a literal caret, so the
filename `version&go.cmd` becomes `version^&go.cmd` and the shim is "not found". Verified live:
the wrapped+escaped shape fails with exit 1, while the wrapped+unescaped
`buildWin32CommandLine` line succeeds. The probes therefore use `buildWin32CommandLine` directly
— which is exactly what the ticket's item 2 prescribes ("pass the command line built by
`buildWin32CommandLine(path, ['--version'])` as a single argument") — and skip the
`quoteForCmd` layer. `buildCmdInvocation` itself was left untouched (out of this ticket's scope).

**Suite results:** `npm run check` — eslint clean; full suite 102 files, all groups green
(adapters 34, contract 2, core 62, helpers 1, integration 3). Run several times; one run showed
an unrelated load-flake (an assertion diff in an untouched core/ test — the runner self-reports
the suite as load-sensitive). All adapter/contract/doctor tests passed on every run.

**Agent checks actual output:**
```
$ rg -n "execSync|spawnSync" adapters/
adapters/shared/run-probe.js:10:const { spawnSync } = require('node:child_process');
adapters/shared/run-probe.js:23: * Returns the child's stdout as a string (mirroring `execSync` with
adapters/shared/run-probe.js:54:  const result = spawnSync(command, args, options);
```
Every `spawnSync` hit passes an argument array; no `execSync` call remains in `adapters/`, and no
site builds a command string by concatenating the executable path. The `npm test -- --grep`
recipe does not exist in this repo's runner (it rejects `--grep` as an unknown flag); the
equivalent coverage is the new metachar tests above, run as part of `npm run check`.
