# 39 — Correct Win32 argv serialization shared by both launch paths

**Blocked by:** None — can start immediately
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` "No console window, ever" section
(the two-layered quoting rule), `AGENTS.md` "Smaller rules" (argument order / argv building).

---

## Purpose

Replace the naive quote-escaping in `adapters/codex/cmd-quoting.js` and the native containment helper
(`native/windows-job-helper/Program.cs`) with one correct, shared Win32 command-line serializer, used by
both the Node-side spawn path and the native helper's own process creation.

## Why it matters

`AGENTS.md` already documents that this project requires two layers of quoting (proper Win32 argv escaping,
plus `cmd /d /s /c` metacharacter escaping for `.cmd`/`.bat` shims) precisely because naive escaping breaks.
Review found the *first* layer itself is wrong in both places it's implemented, independently, which means
prompts or arguments containing embedded quotes, backslashes immediately before a closing quote, trailing
backslashes inside a quoted argument, or `%NAME%`-shaped text can be altered, split, or interpreted as shell
syntax by the receiving process — silently corrupting what's actually sent to the backend CLI.

## Evidence (verified via code read)

`adapters/codex/cmd-quoting.js` (~line 17, ~line 83) escapes `"` by naive replacement with `\"`, which is
not the actual `CommandLineToArgvW` algorithm (that algorithm requires doubling backslash *runs* that
precede a quote, and different handling of backslash runs at the end of an argument). Caret-prefixing `%`
does not reliably suppress `cmd.exe` variable expansion in all contexts either.
`native/windows-job-helper/Program.cs` (~line 334) repeats the same incorrect algorithm independently — so
the two paths are not just individually wrong, they can also disagree with each other.

## Design

- Implement one correct Win32 command-line argument serializer (the well-known algorithm: for each
  argument, if it needs quoting, wrap in quotes; when writing a backslash run, double it if followed by a
  closing quote or if it's at the end of the argument and the argument is quoted; write embedded quotes as
  `\"` only after correctly doubling any preceding backslash run). This is a well-documented algorithm
  (mirrors what `CommandLineToArgvW` parses) — implement it once, precisely, with unit tests covering the
  documented edge cases.
- Implement the `cmd /d /s /c` metacharacter-escaping layer separately and explicitly, per the existing
  two-layer design in `AGENTS.md` — do not conflate the two layers into one pass.
- Put the argv serializer in one place importable by both the Node-side `cmd-quoting.js` callers and — since
  `Program.cs` is C#, not JS — either port the identical algorithm to C# with a shared golden test-vector
  file both sides run against, or restructure so only one side actually builds argv strings and the other
  receives already-serialized arguments. Prefer whichever avoids duplicated logic that can drift again.
- Round-trip test: build a command line for a real `.exe` and a real `.cmd`/`.bat` fixture with adversarial
  arguments (embedded quotes, backslash-before-quote, trailing backslash inside quotes, `%FOO%`), spawn it,
  and assert the child actually received the exact original argument (e.g., via a fixture that echoes
  `process.argv` back as JSON).

## Pitfalls

- Do not test this only with string-literal assertions on the built command line — the real test is
  spawning a real process and confirming what it *received*, since it's easy to build a command line that
  looks right but parses differently than intended.
- Remember `shell: true` is banned (already established elsewhere in this codebase) — do not "fix" this by
  reaching for it.

## Checklist

- [ ] One correct Win32 argv serializer exists and is used by both `cmd-quoting.js` and the native
      containment helper (or the native helper receives pre-serialized arguments from the same source).
- [ ] A golden test-vector set covers: plain arguments, arguments with spaces, embedded quotes, backslash
      runs before a closing quote, trailing backslashes inside a quoted argument, and `%NAME%`-shaped text.
- [ ] A round-trip test spawns a real `.exe` fixture and a real `.cmd`/`.bat` fixture with each adversarial
      argument and asserts the received argument exactly matches the original.
- [ ] The `cmd /d /s /c` metacharacter-escaping layer is implemented and tested independently of the Win32
      argv layer.

## How to verify

```powershell
node tests/run-tests.js --suite full
node tests/adapters/codex   # or wherever the new golden/round-trip tests land
```

## Definition of done

Full suite green; round-trip tests against real `.exe` and `.cmd` fixtures prove every adversarial argument
in the golden set survives unaltered through both launch paths.

## Commit message

```
fix: implement a correct, shared Win32 argv serializer for both launch paths
```
