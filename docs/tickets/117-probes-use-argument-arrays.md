# 117 — version and doctor probes execute interpolated shell strings instead of argument arrays

**Status:** ready
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

(Left empty by the author. The implementer fills it in: what was changed and where, build and suite
results, the Agent checks' actual output, any deviation from this ticket and why, and anything
discovered that contradicts the docs.)
