# 26 — claude adapter

**Blocked by:** 25
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), [reference/cli-claude.md](../reference/cli-claude.md),
[ADR-005](../2026-07-28-architecture-decisions.md#adr-005).

---

## Purpose

`dcli-claude` runs work through a child Claude Code process on the shared engine, with the wrapper owning the job
lifecycle.

## Why it matters

This backend is last for two reasons, and both are load-bearing.

**It has the most unverified behavior.** Unlike opencode, nobody has confirmed whether `claude -p` can block
indefinitely on a permission decision, or which `--permission-mode` values are safe unattended. Assume it can
block — treat it as the same hazard class as opencode's CLI path — until you prove otherwise.

**It is the only backend with its own job manager.** `--bg` plus `claude agents` overlaps the wrapper's entire job
model. Two managers create ambiguous authority over status, results, containment, and crash recovery. ADR-005
bypasses it.

## Step 1 — verification before implementation

Answer these first and record them in Notes and the reference doc. The design depends on the answers:

1. Can `claude -p` block indefinitely on a permission decision? Which `--permission-mode` values are safe
   unattended (`auto`, `dontAsk`, `acceptEdits`, `manual`, `plan`, `bypassPermissions`)?
2. Does `--input-format stream-json` provide a control channel to **answer** a permission mid-run? If it does,
   `Respond` becomes implementable and this backend gains a capability opencode has. If not, declare it absent.
3. Does `--bare` break auth on an OAuth-only host? Its help says OAuth and keychain are **never** read under
   `--bare`, and auth becomes strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings`. Probe it in doctor
   rather than discovering it inside a job.
4. What is the exact `stream-json` event schema — message types, how the final assistant text is identified, how
   errors and denials surface, and whether `--include-partial-messages` changes framing?
5. Does `--json-schema` degrade gracefully on failure, or corrupt the session the way opencode's does?

If (1) shows it can block, the classification work from ticket 20 applies here too: pending-interaction-while-busy
is **blocked**, not `timeout`.

## Facts you need (Claude Code 2.1.220)

| Need | Mechanism |
|---|---|
| non-interactive | `-p/--print` |
| event stream | `--output-format stream-json` |
| single result | `--output-format json` |
| job identity up front | `--session-id <uuid>` — the wrapper assigns it |
| resume | `-r/--resume <id>`; `--fork-session` for a branch |
| model | `--model` (alias or full name) |
| effort | `--effort low\|medium\|high\|xhigh\|max` |
| isolation | `--permission-mode` + `--allowedTools`/`--disallowedTools`/`--tools` |
| extra dirs | `--add-dir` |
| clean run | `--bare` (mind the auth consequence) or `--safe-mode` |
| purpose-built agent | `--agents <inline json>` |
| cost guards | `--max-budget-usd`, `--max-turns` |
| no persistence | `--no-session-persistence` |
| doctor | `claude doctor` — **no `--json`**, so the adapter builds the envelope itself |
| auth remediation | `claude auth`, `claude setup-token` |

Not used, recorded as namespaced extensions: `-w/--worktree`, `--bg`/`claude agents`, `--from-pr`,
`ultrareview`, `--json-schema`.

`--session-id` accepting a caller-supplied UUID is genuinely useful: assign it up front instead of scraping it
from output, which removes a whole class of lineage bug.

## Concrete patterns to reuse — don't reinvent these

`adapters/codex/adapter.js` (752 lines) is a completed, tested adapter on the same engine, built by
ticket 25. It is not just prose guidance — it is the pattern to mirror line-by-line where the shape
matches:

- **Method surface.** `adapters/fake/adapter.js` is the definitive shape every adapter implements —
  `GetIdentity`, `DetectVersion`, `ProbeCapabilities`, `DeclareCancelRungs`, `ValidateRequest`,
  `PrepareInvocation`, `Start`, `Observe` (async generator yielding facts), `SendPrompt`, `Resume`,
  `Respond`, `RequestCancel`, `CollectResult`, `CollectDiagnostics`, `Dispose`, `Recover`,
  `LiveSmoke`. Build `ClaudeAdapter` against this shape from the start rather than discovering
  missing methods when the contract suite fails.
- **Executable resolution.** `resolveVendorBinaryNear`/`resolveCodexPath` in
  `adapters/codex/adapter.js:21,77` resolve past the npm `.cmd`/`.ps1` shim ambiguity. `claude` has
  the identical npm-shim shape — mirror this resolver, don't write a second one from scratch.
- **`.cmd` quoting.** `adapters/codex/cmd-quoting.js` (92 lines, covered by
  `tests/adapters/codex/cmd-quoting.test.js`) is the two-layer Win32-plus-metacharacter quoting this
  project already got right once. `claude.cmd` has the same `EINVAL`-on-direct-spawn problem
  (`docs/reference/cli-claude.md:211`). **Do not copy-paste a second implementation of this
  file** — import it directly from `adapters/codex/cmd-quoting.js`, or if that import feels wrong
  layered across adapter boundaries, move it to a shared location (e.g. `core/`) and have both
  adapters import the one copy. A hand-rewritten duplicate is exactly the kind of drift AGENTS.md's
  invariant 1 exists to prevent, even though quoting logic itself isn't the backend-conditional the
  invariant is aimed at.
- **CLI entrypoint.** There is no `cli/dcli-claude.js` yet — only `cli/dcli.js`, `cli/dcli-codex.js`,
  `cli/dcli-opencode.js` exist. Mirror `cli/dcli-codex.js`'s structure (argument parsing, dispatch,
  the "help exits before heavyweight imports" rule from `AGENTS.md`) rather than designing the
  entrypoint shape fresh.
- **Resume wiring.** Per ticket 25's Notes: `Resume()` just records the resume kind; the **engine**
  (`executeResume`) is what creates the new job and calls `Start`/`SendPrompt` on the adapter. Reuse
  that engine call path for `-r/--resume <session-id>` + `--fork-session` — do not build a
  claude-specific resume flow in the adapter.
- **Supported-but-unused capabilities.** Ticket 25 declared `--output-schema` as
  `{ supported: true, reason: '...' }` rather than omitting it or silently ignoring it. Apply the
  same shape to `--json-schema`, native worktree (`-w`), `--bg`/`claude agents`, `--from-pr`, and
  `ultrareview` — each gets a `ProbeCapabilities()` entry naming why it's unused, not just a line in
  this doc.
- **Gates to actually run.** `tests/contract/contract.test.js` and
  `tests/contract/parity-gate.test.js` are the suites that must pass — run them directly while
  iterating, not only at the end via `--suite full`.

## Design

1. `Start`: `claude -p --output-format stream-json --session-id <uuid> …` under containment, argv as an array.
2. Map `stream-json` messages onto closed-set facts. Log unknown message types; never fatal.
3. Access mapping — and it must be **verified, not assumed**:
   - `read-only`: a permission mode plus `--disallowedTools`/`--tools` that provably prevents mutation of the
     canonical directory. Write a test that *attempts* a mutation and asserts it fails.
   - `workspace`: mutation allowed **inside the worktree only**.
4. Use `--agents` to supply a minimal purpose-built agent per mode instead of touching user configuration.
5. Base runs on `--safe-mode` (or `--bare`, subject to the step-1 auth finding) — this also serves the recursion
   guard by disabling skills.
6. Wire `--max-turns` and `--max-budget-usd` to wrapper-level guards so a runaway job has a cost ceiling as well
   as a time ceiling.
7. `DeclareCancelRungs()` → `['hard_kill']`, unless step 1 finds a graceful mechanism.
8. Doctor builds its own envelope: executable resolution, version range, expected flags present in `--help`, auth
   reachability, and the `--bare` auth finding.

## Pitfalls

- npm-style shim resolution applies here too — resolve to the executable form.
- Do not use `--dangerously-skip-permissions` as an access mode. Ever.
- Under `--bare`, settings files that fail validation are **silently ignored** in print mode — do not rely on a
  settings file being honored without verifying it.
- Do not use native `--bg`; ADR-005.
- Do not claim `read-only` prevents *reading* credentials — it does not (ADR-004 amendment).

## Checklist

- [ ] All five step-1 questions are answered and recorded in Notes and `reference/cli-claude.md`.
- [ ] If `-p` can block, pending-interaction-while-busy is classified **blocked** (exit `15`), not `timeout`.
- [ ] `Start` uses `-p --output-format stream-json` with a wrapper-assigned `--session-id`, argv as an array.
- [ ] `stream-json` maps onto closed-set facts only; unknown message types are logged, non-fatal.
- [ ] The final assistant text is identified per the step-1 schema finding, not guessed.
- [ ] `read-only` access **provably** prevents mutation — a test attempts a write and asserts it fails.
- [ ] `workspace` access permits mutation only inside the worktree.
- [ ] `--agents` supplies a per-mode minimal agent; user configuration is never modified.
- [ ] Runs are based on `--safe-mode`/`--bare` per the auth finding; skills are disabled.
- [ ] `--max-turns` and `--max-budget-usd` are wired to wrapper guards.
- [ ] `DeclareCancelRungs()` reflects reality; `Respond` is declared only if step 1 proved it possible.
- [ ] Doctor builds its own envelope including the `--bare` auth probe; `--json` works even on failure.
- [ ] Native worktree, `--bg`, `--from-pr`, `ultrareview`, and `--json-schema` are declared as unused extensions
      with reasons.
- [ ] `.cmd` shim invocation goes through `%ComSpec% /d /s /c`; a direct `spawn("claude.cmd")` would fail
      `EINVAL` on modern Node and must never be attempted.
- [ ] Every spawn passes `windowsHide: true`; no descendant owns a visible window.- [ ] Executable resolution uses the executable form; npm-shaped PATH test.
- [ ] `--dangerously-skip-permissions` is unreachable from any wrapper access mode — asserted.
- [ ] The contract suite and the parity gate still pass.

## How to verify

```powershell
node tests/run-tests.js --suite full
node cli/dcli-claude.js doctor --json
node cli/dcli-claude.js run --hard-timeout-sec 600 --access read-only "Summarize AGENTS.md in three bullets."
```

Then attempt a mutation under `--access read-only` and confirm it is refused.

## Definition of done

Step-1 findings recorded; read-only provably prevents mutation; contract suite and parity gate green.

## Commit message

```
feat(claude): adapter on the shared engine with verified access mapping
```

## Notes

Record the five step-1 findings here.
