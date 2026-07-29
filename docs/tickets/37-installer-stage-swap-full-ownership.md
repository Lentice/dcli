# 37 — Installer must stage-and-swap the complete owned tree, not merge

**Blocked by:** None — can start immediately
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` §"The nine mistakes" #9,
ticket 24's Notes section (the guard-2 scoping history — read this before touching install.ps1 again).

---

## Purpose

`install.ps1` must stage the complete set of files it owns and atomically swap them into place, and its
post-install verification must cover every owned file, not only ones with a matching repo hash.

## Why it matters

Ticket 24 already fixed the worst version of this (refusing to install into a foreign/colliding directory).
This ticket addresses a narrower but still real gap in the *upgrade* path: even with staging in place,
`Copy-Item -Recurse -Force` from the staging directory into the live install directory **merges** rather
than replacing — so a file removed in a newer release (a deleted skill, a renamed rule) survives as a stale
file in the live install. Combined with cleanup only covering the command namespace (not skills/rules), an
upgrade can silently leave a previous release's generated file installed and readable by an agent
indefinitely.

## Evidence (verified via code read)

`install.ps1`: staging/copy around line 91, namespace cleanup around line 111 (covers command namespaces
only), the merge copy around line 120, and verification around line 130 that skips any installed file
lacking a corresponding repo-hash entry rather than treating "installed file with no source" as a defect.

## Design

- For every namespace the installer owns (skills, commands, rules — not just commands), **empty the
  destination namespace before copying**, the same way commands are already emptied — or, better, swap in
  a freshly staged version of the whole owned subtree atomically, consistent with ticket 24's original
  stage-and-swap intent.
- Respect the ownership-manifest boundaries from ticket 24/ADR-009: only ever touch paths this tool proves
  it owns (via the marker/manifest), never a whole shared directory like `~/.claude/rules/` that can
  contain unrelated files (`context7.md` etc. — this was the exact overcorrection ticket 24's Notes section
  already documents and fixed once; do not reintroduce it while fixing this).
- Post-install verification should assert **two** things, not one: (a) every file the manifest says should
  exist does exist and hash-matches the repo, and (b) no *stale* owned file from a previous version remains
  (i.e., the installed owned-file set exactly equals the current manifest's file set, no more, no less).

## Pitfalls

- This is the second time this exact area has needed a fix (see ticket 24's Notes) — re-read that history
  before changing scope. The failure mode to avoid is swinging back to "refuse to install into any
  non-empty shared directory," which ticket 24 already proved refuses on nearly every real user's machine.
- Keep the fix scoped to *this tool's own owned files*, identified via the manifest, not directory-level
  emptiness checks.

## Checklist

- [ ] Upgrading over an existing install removes files that were owned by the previous version but are
      absent from the new version's manifest (a planted "stale" file from a prior version is gone after
      upgrade) — for skills and rules, not just commands.
- [ ] The fix does not regress ticket 24's two refusal guards or its foreign-file tolerance (re-run its
      regression tests).
- [ ] Post-install verification fails if any owned file's hash doesn't match, **and** fails if any owned
      file exists that the current manifest doesn't call for.
- [ ] A regression test upgrades from a synthetic "previous version" fixture (extra skill/rule file) to the
      current generated set and asserts the extra file is gone afterward.

## How to verify

```powershell
node tests/run-tests.js --suite full
pwsh -NoProfile -File install.ps1
node tests/integration/installer.test.js
```

## Definition of done

Full suite green; an installer upgrade test proves a stale skill/rule file from a simulated previous
version is removed, and post-install verification catches both missing/mismatched and unexpectedly-present
owned files.

## Commit message

```
fix: installer removes stale owned files across skills and rules on upgrade, not just commands
```
