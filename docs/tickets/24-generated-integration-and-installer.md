# 24 — Generated Claude integration and installer

**Blocked by:** 23
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` §1, §9, and
"Documentation maintenance", [ADR-001](../2026-07-28-architecture-decisions.md#adr-001).

---

## Purpose

The installed Claude Code integration — three per-backend skills, per-command slash commands, and the delegation
rule — is **generated from one source**, checked in, and verified to byte-match what is installed.

## Why it matters

This ticket is where the "three skills, not one" decision is actually implemented, and where the tool's two most
expensive doc failures are prevented.

**Cross-adapter flag leakage.** A single flat skill listing options that only work on some backends is exactly
what makes an invoking agent infer symmetry and compose an invalid call. Three generated skills prevent it — but
only if a build check enforces that one adapter's flag never appears in another's skill.

**Unbounded recipes.** The predecessor's worst incident — an eight-hour stall consuming a whole working session —
happened because the *installed templates* taught recipes with no execution or wait budget. Docs were the bug.
Every generated recipe must carry both budgets.

**The installer can delete everything.** `Copy-Item -Recurse -Force` over an existing install *merges*, so a
module deleted in a newer version survives as a stale file. And a review found that pointing the install
directory at the wrong place made the script directory the job-state root, after which the mirror **deleted all
job state**.

## Design

### Generation

Source of truth, in `integration/source/`: `core.md`, `codex.md`, `opencode.md`, `claude.md`, `router.md`.
Combined with core command metadata, the exit-code contract, and each adapter's capability manifest to produce:

```
integration/generated/skills/{ccodex,dcli-opencode,dcli-claude,dcli}/SKILL.md
integration/generated/commands/{ccodex,dcli-opencode,dcli-claude}/{review,ask,implement,resume,jobs,doctor,cleanup}.md
integration/generated/rules/dcli-delegation.md
integration/generated/worker-prompts/*.md
```

Generated files are **checked in**. CI fails if they are stale.

`dcli/SKILL.md` is a **router only**: choose a backend, then load that backend's skill. It must not
reproduce all three references.

### What each skill must teach

- Delegate only bounded, worthwhile work; **always pass an execution budget and a wait budget**.
- Prefer background submission for long tasks; use `wait --all --group` to gather, never a hand-rolled poll loop.
- **Independently verify every finding.** Never present a delegated review's raw output as your own conclusion.
- **Never auto-apply.** Inspect `diff` before `apply`, and make an explicit adopt/reject decision.
- Use exact wrapper lineage; never "continue last session".
- React per the failure-class table; **never retry** quota, auth, permission, or timeout failures.
- Keep review intent neutral — intent is context, not evidence.
- `findings_status: malformed` is **not** a clean review.
- Keep delegated work out of the caller's context until collection, when token saving is the point.

Plus the per-backend truths: `dcli-opencode --variant` (unbounded string) vs `dcli-codex/dcli-claude --reasoning-effort`
(different enums); which backends can answer an interaction; which have graceful cancel; that opencode's
structured output is unusable.

### The project policy file

`.dcli/policy.json`, all keys optional, with documented defaults and **strict integer range validation**
(a real bug class — validate before use, whole numbers only, explicit inclusive bounds):

```json
{ "delegation": { "review_after_changes": "ask", "review_min_changed_lines": 50,
                  "review_default_paths": [], "plan_second_opinion": "ask",
                  "max_calls_per_task": 2, "default_backend": "codex",
                  "default_model": null, "allow_network": false } }
```

### The installer

- **Stage and swap, never merge.** Build the new tree at `<dest>.staging`, then swap it in whole; remove the old
  copy only after the complete new one exists, so a failed copy never leaves a half-installed CLI.
- Empty the namespaced command directory first, so removed commands do not linger as ghosts.
- **Ownership manifest (ADR-009).** The installer hard-refuses to overwrite any target it cannot positively
  identify as its own — shim paths, skill directories, command directories, rule files, and the state root,
  each checked independently. Ownership is proven by a manifest carrying a stable product id, schema version,
  and installed-file hashes. *"The directory already has the expected name" is not proof.* Provide an explicit
  uninstall/migration operation; provide **no** generic force-overwrite that bypasses the check. This is what
  stops `dcli` from ever clobbering the predecessor `ccodex` installation, which remains live throughout.
- **Two refusal guards, both load-bearing:** refuse an install directory that collides with the state root, and
  refuse to replace an existing non-empty directory that lacks the tool's marker file.
- After install, **verify installed copies byte-match the repo** (hash per file).

Accepted known minor: an invocation launched in the millisecond window between removal and rename can fail once;
rerunning succeeds. Versioned release directories were judged disproportionate for a rare manual operation —
document it rather than pretending otherwise.

## Pitfalls

- Do not hand-edit a generated file. Fix the source and regenerate.
- Do not let the router skill grow into a fourth full reference.
- Do not document a capability that is not declared, or declare one that is not documented — CI checks both.
- Do not skip the byte-match verification. "It installed fine" is not evidence.

## Checklist

- [ ] All generated artifacts are produced from `integration/source/` plus command metadata and capability manifests.
- [ ] Generated files are checked in; CI fails when they are stale.
- [ ] Four skills exist: three per-backend plus a router that does not duplicate them.
- [ ] **A build check fails if one adapter's flag appears in another adapter's skill.**
- [ ] A build check fails if a public command lacks skill documentation.
- [ ] A build check fails if a capability is documented but not declared, or declared but not documented.
- [ ] **Every generated recipe includes an execution budget and a wait budget** — a check greps for recipes
      lacking them and fails.
- [ ] Skills teach: independent verification, never auto-apply, inspect `diff` first, exact lineage, no retry on
      quota/auth/permission/timeout, neutral intent, and that `malformed` findings are not clean.
- [ ] `.dcli/policy.json` is read with strict inclusive integer range validation, validated before use.
- [ ] Installer stages and swaps whole; a planted stale file from a previous version is gone after upgrade.
- [ ] Installer empties the namespaced command directory so removed commands leave no ghosts.
- [ ] Installer refuses a directory colliding with the state root — regression test.
- [ ] Installer refuses to replace a non-empty foreign directory lacking the marker file — regression test.
- [ ] A failed copy never leaves a half-installed CLI.
- [ ] Post-install verification compares per-file hashes of installed copies against the repo.
- [ ] The known install-window minor is documented in `README.md`.

## How to verify

```powershell
node tests/run-tests.js --suite full
node scripts/generate-integration.js --check      # must report no drift
pwsh -NoProfile -File install.ps1
# then verify byte-match, e.g.
Get-ChildItem "$env:USERPROFILE\.claude\skills\dcli-opencode" -Recurse -File |
  ForEach-Object { Get-FileHash $_.FullName }
```

## Definition of done

Full suite green, generation reports no drift, the two installer refusal guards are tested, and installed copies
byte-match the repo.

## Commit message

```
feat: generate per-backend Claude integration and add a mirroring installer with refusal guards
```

## Notes
