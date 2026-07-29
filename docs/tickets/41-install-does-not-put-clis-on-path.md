# 41 — Installer never puts the `dcli*` CLIs on PATH

**Blocked by:** None — can start immediately
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), ticket 24 (installer design),
`AGENTS.md` "Smaller rules" (resolve executables to the executable form; npm installs both `.cmd`/`.ps1`).

---

## Purpose

After running `install.ps1` (or whatever setup a user follows), the commands `dcli`, `dcli-codex`,
`dcli-opencode`, and `dcli-claude` must actually be runnable as bare commands from any shell — matching
every documented recipe in `README.md` and every generated skill/worker-prompt.

## Why it matters

Every recipe in this project — `README.md`, all three generated `SKILL.md`s, every generated command doc,
every worker prompt — is written as `dcli-opencode run ...`, `dcli-codex submit ...`, etc., assuming these
are bare commands on `PATH`. Nothing in the repo currently makes that true. An agent (or human) who
installs exactly per the documented process and then follows any recipe verbatim gets `command not found`.

## Evidence (verified live on this machine)

- `package.json` has no `"bin"` field at all:
  ```json
  { "name": "dcli", "version": "0.0.0", "private": true, "type": "commonjs", "engines": {"node": ">=22.0.0"}, "description": "..." }
  ```
  So even `npm link` / `npm install -g .` would not create any of the four shims.
- `install.ps1` only stages/copies `integration/generated/*` (skills, commands, rules) into `-InstallDir`
  (default `~\.claude`) — it never touches `PATH`, never creates a shim, wrapper script, or symlink for any
  of the four CLI entry points in `cli/`.
- Confirmed via `which dcli`, `which dcli-opencode`, `which dcli-codex`, `which dcli-claude` on this
  machine (with the repo cloned and `install.ps1` run) — none resolve. Every command in this session had
  to be invoked as `node cli/dcli-codex.js ...` etc. instead of the documented bare form.

## Design

- Add a `"bin"` field to `package.json` mapping `dcli`, `dcli-codex`, `dcli-opencode`, `dcli-claude` to
  their respective files under `cli/`, so a standard `npm install -g .` (or `npm link` for local dev)
  creates the shims the normal way.
- Decide and document the actual supported install path for end users — likely "run `npm install -g .`
  (or equivalent) from the repo, then run `install.ps1` for the Claude Code integration" — and make sure
  `install.ps1` either performs or clearly instructs this step; a user should not have to discover the
  `bin` field's existence to get a working install.
- Remember the project's own documented Windows npm-shim fact: npm installs *both* `.cmd` and `.ps1` for a
  bin entry, and PowerShell ranks the `.ps1` higher, which `Process.Start` cannot execute — this is exactly
  the "resolve executables to the executable form" rule already in `AGENTS.md`. If `install.ps1` or any
  future setup step needs to invoke these shims itself (e.g., for the doctor live-smoke check), it must
  resolve to the `.cmd` (or the underlying script) explicitly, not rely on default shell resolution.
- Update `README.md` with an explicit "Setup" section covering this step — currently it jumps straight
  from "why" to recipes, with no install instructions at all beyond the skill/rule installer.

## Pitfalls

- Don't assume "the user probably ran `npm link` themselves" — nothing in the repo tells them to, and the
  installer's job is to make the documented recipes actually work out of the box.
- Don't conflate this with `install.ps1`'s existing responsibility (Claude Code skills/commands/rules) —
  keep them as two clearly sequenced steps if they can't reasonably be one, but make sure neither is
  optional/undiscoverable.

## Checklist

- [x] `package.json` has a `"bin"` field for `dcli`, `dcli-codex`, `dcli-opencode`, `dcli-claude`.
- [x] A documented, single command sequence (in `README.md`) takes a fresh clone to all four commands being
      runnable bare from a new shell, plus the Claude Code integration installed.
- [x] The sequence is verified to work on a clean shell (new terminal, not the one used for `npm link`) —
      i.e. PATH changes are actually picked up, not just true "in theory." Verified via `npm link` +
      `Get-Command`/`which` + running `--help` bare, in both PowerShell and Bash, then undone with
      `npm rm --global dcli`.
- [x] Any place `install.ps1` (or a setup script) itself needs to invoke one of these CLIs resolves to the
      `.cmd` form explicitly, not default PowerShell resolution. `install.ps1` does not itself invoke any
      `dcli*` CLI (it only stages/copies the integration tree), so this is vacuously satisfied — noted here
      since it wasn't obvious from a first read of the script.
- [x] `README.md`'s setup instructions are updated to match reality.

## How to verify

```powershell
git clone <repo> fresh-clone
cd fresh-clone
# run whatever the documented setup sequence ends up being
pwsh -NoProfile -File install.ps1
# open a brand-new shell and:
dcli-opencode --help
dcli-codex --help
dcli-claude --help
```

## Definition of done

A fresh clone, following only `README.md`'s documented setup steps, ends with all four `dcli*` commands
runnable bare from a new shell.

## Commit message

```
fix: add npm bin entries and document setup so dcli* commands actually resolve on PATH
```
