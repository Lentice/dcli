# 65 — Codex temp dir is leaked when `spawn` throws synchronously after `mkdtempSync`

**What to build:** the codex adapter's per-job temp directory (the `result.txt` working dir) is cleaned up if `spawn` throws between the `mkdtempSync` and the finally-protected cleanup. Today, the temp dir is orphaned in `%TMP%` on every synchronous spawn failure (the EINVAL that ticket 52 fixes will produce many of these when fixed-elsewhere-by-ticket 53; but even today, `ENOENT`/`EACCES`/EBADF on stdio leaks the dir).

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `adapters/codex/adapter.js` `Start` (around line 318-322, `mkdtempSync` then spawn) wraps the spawn in `try` such that a synchronous throw triggers `fs.rmSync(this._tmpDirPath, { recursive: true, force: true })` then rethrows the original error.
- [ ] `Dispose` already calls `fs.rmSync(this._tmpDirPath, ...)` when `_tmpDirPath` is set — verify and keep. The Start-side cleanup is only the synchronous-spawn-throws path; if `Start` succeeds, `Dispose` (ticket 31 — Dispose on every terminal path) owns cleanup.
- [ ] Test: a fake codex adapter whose `spawn` target resolves to a path that synchronously throws (e.g. an empty-string command) leaves ZERO files in `os.tmpdir()` named `dcli-codex-*` after the attempt fails. (Count before/after; assert delta == 0.)
- [ ] Test: a successful `Start` followed by `Dispose` also leaves zero `dcli-codex-*` dirs (preserve today's behaviour).
- [ ] Full suite green.

## Development guidance

- The pattern "create resource then spawn, leak on throw" is general. As a sweeping rule, every `mkdtempSync`/`mkdirSync` followed by an action that can throw should be in a `try` that cleans up the dir. Apply it here; file follow-ups for the opencode/claude adapters if you find the same pattern (don't expand this ticket scope — coordinate via a follow-up), but DO at minimum grep for the same pattern in `adapters/opencode/adapter.js` and `adapters/claude/adapter.js` and note in the commit body whether they have the same gap.
- Use `fs.rmSync(path, { recursive: true, force: true })` — `force: true` so a missing dir (e.g. if cleanup ran twice on a re-entry path) doesn't throw.
- The static-analysis smell: any `mkdtempSync` followed within the same function by `spawn(...)` or other throw-capable call without an intervening `try` is suspect. Run `grep` after the fix to confirm.
- Don't introduce a global "leaked temp registry" — the try/catch is localized, simple, and enough. A registry is a separate, larger feature.

## Why it matters

A user who crash-loops codex-today (capacitive `spawn` failure, anti-virus blocking stdio, a path-length bug) leaks a directory per attempt. Over a busy day, `%TMP%` fills and the next job fails for an unrelated reason (disk full) — masking the real cause. AGENTS §9 is about "the installer can delete everything"; this is the smaller but parallel "the wrapper can fill tmp on every failure."

## How to verify

```powershell
node tests/run-tests.js --suite full
# Before/after tmp count:
Get-ChildItem $env:TEMP -Directory -Filter "dcli-codex-*" | Measure-Object
```

## Commit message

```
fix(codex): clean up temp dir on synchronous spawn failure
```