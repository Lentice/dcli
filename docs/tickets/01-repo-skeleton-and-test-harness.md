# 01 — Repo skeleton, test harness, quick/full runner

**Blocked by:** None — can start immediately.
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md). Nothing else.

---

## Purpose

A developer clones the repository, runs one command, and gets a green test suite. A second command runs
only the fast subset and prints which files it skipped. Nothing functional is built here — this is the
floor everything else stands on.

## Why it matters

Every later ticket is TDD: write failing tests, verify red, implement, verify green. If the harness is
awkward, every subsequent ticket pays for it. Two specific things must be right from the start, because
retrofitting them is painful:

- **Per-suite reporting.** Later there will be three adapters. If one broken adapter can mask failures
  elsewhere, regressions hide.
- **UTF-8 without BOM through a shared writer.** If files are written ad hoc with whatever the platform
  default is, BOMs leak into job artifacts and downstream JSON parsers break. Centralize it now.

## Design

### Directory skeleton

Create these with a `.gitkeep` or a stub `index.js`, so later tickets have a home:

```
cli/            core/           core/commands/    adapters/codex/
adapters/opencode/  adapters/claude/  native/windows-job-helper/
integration/source/  integration/generated/
tests/core/  tests/contract/  tests/adapters/  tests/integration/  tests/fixtures/
```

### Node project

- `package.json` with `"type": "commonjs"` or `"module"` — pick one and be consistent. No bundler, no
  transpiler, no TypeScript compile step.
- A `jsconfig.json` enabling `checkJs` and `strict` for editor/CI type checking of JSDoc annotations.
  This must **not** be a build step: `node cli/delegate.js` runs the source directly.
- Node version floor recorded in `engines`. Pick the oldest version whose `AbortSignal`, `fs.rm`, and
  `structuredClone` behavior you rely on.

### The shared text writer (`core/fs-text.js`)

Two functions, used by everything from here on:

```
writeTextFileAtomic(path, string)   // UTF-8, no BOM, temp + fsync + rename
writeJsonFileAtomic(path, value)    // same, JSON.stringify with stable key order
appendJsonLine(path, value)         // UTF-8, no BOM, single '\n'-terminated line
```

"Atomic" means: write to `<path>.tmp-<random>`, flush, close, then rename over the target. Detect at
startup whether the filesystem supports atomic rename and record it; do not assume.

### The runner (`tests/run-tests.js`)

- Discovers `tests/**/*.test.js`.
- Runs each in a **child process** so a crash or `process.exit` in one file cannot take down the run.
- A test file signals failure by a **non-zero exit code**. There is no framework, no `describe`, no
  assertion library requirement beyond `node:assert`.
- Groups results by top-level directory under `tests/` and prints one line per group:

```
core:        12 passed
contract:     0 passed  (no adapters yet)
adapters:     0 passed
integration:  0 passed, 3 skipped (opencode not installed)
```

- `--suite quick` (or default) skips files marked slow; `--suite full` runs everything.
- A file marks itself slow with a first-line comment sentinel, e.g. `// @suite full`. Skipped files are
  **listed by name**, never silently omitted.
- Exit non-zero if any group has a failure. Exit zero on an empty suite.

## Pitfalls

- **Do not add a test framework.** The predecessor project deliberately avoided one; assertion scripts
  plus exit codes have proven sufficient and keep the dependency surface at zero.
- **Do not let the quick suite hide anything.** "Skipped" must be visible in the output. A silently
  shrinking suite is how coverage rots.
- Do not use `fs.writeFileSync` directly anywhere outside `core/fs-text.js` for tool-authored files.

## Checklist

- [ ] Directory skeleton from Design exists and is committed.
- [ ] `package.json` has no build script; `node cli/delegate.js --help` runs from source.
- [ ] `jsconfig.json` enables `checkJs`; a deliberately-wrong JSDoc annotation is reported by the type
      checker (verify manually once, then revert).
- [ ] `core/fs-text.js` provides the three writers, all UTF-8 **without BOM**.
- [ ] A test asserts every writer's output has no BOM (`0xEF 0xBB 0xBF`) as its first bytes.
- [ ] A test asserts `writeJsonFileAtomic` leaves no `.tmp-*` file behind on success.
- [ ] `tests/run-tests.js` runs each test file in a child process.
- [ ] Failure is detected by non-zero exit code, not by parsing output.
- [ ] Results are grouped per suite, one line per group.
- [ ] `--suite quick` skips `// @suite full` files and **lists them by name**.
- [ ] `--suite full` runs everything.
- [ ] The runner exits non-zero if any group fails, and zero on an empty suite.
- [ ] `README.md` documents both invocations.

## How to verify

```powershell
node tests/run-tests.js                 # quick; should be green and list skips
node tests/run-tests.js --suite full    # full; should be green
node cli/delegate.js --help             # runs from source, no build
```

Then plant a deliberately failing test file and confirm the runner exits non-zero and names it.

## Definition of done

Both runner invocations are green, the skip list is visible, the BOM tests pass, and `README.md`
documents how to run the suites.

## Commit message

```
chore: repository skeleton, atomic UTF-8 writers, and test runner
```

## Notes

Record here anything you discovered that contradicts the docs.
