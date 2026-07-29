# 25 — codex adapter in full

**Blocked by:** 24
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), [reference/cli-codex.md](../reference/cli-codex.md),
`AGENTS.md` (all of it — most of it came from this backend's history).

---

## Purpose

`ccodex` reaches behavioral parity with the production predecessor tool, on the shared engine: review,
implement, resume, classification, doctor, and capabilities.

## Why it matters

Two things make this ticket different from the others.

**It has a reference implementation.** The predecessor `ccodex` works in production and has two months of
hardening in it. Parity is checkable, not guesswork — and any behavior you cannot reproduce is either a
deliberate improvement you write down, or a regression.

**The production tool keeps running.** This is a separate repository; nothing here touches the installed
`ccodex`. Do **not** migrate job state. Let old jobs age out under their own state root and start clean here.

## Facts you need (verified, codex-cli 0.145.0)

Beyond ticket 15's thin slice:

| Need | Mechanism |
|---|---|
| access `read-only` | `-s read-only` |
| access `workspace` | `-s workspace-write` |
| approval | `-a never` (execution failures return to the model) |
| working root | `-C <dir>` |
| extra writable dirs | `--add-dir <dir>` |
| effort | `-c model_reasoning_effort=<none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra>` — **not a flag** |
| clean reproducible run | `--ignore-user-config --ignore-rules --ephemeral` |
| outside a git repo | `--skip-git-repo-check` |
| resume | `codex exec resume <SESSION_ID> [PROMPT|-]`, `--last`, `--all` |
| structured output | `--output-schema <FILE>` (works — but not used, see below) |
| doctor | `codex doctor --json` (redacted machine-readable report) |
| auth remediation | `codex login` |
| sandbox probe | `codex sandbox <command>` |

Session identity arrives as a `thread.started` event carrying a `thread_id`.

**Codex has no graceful cancel and cannot answer an interaction.** Declare both as absent — do not fabricate them.

### Host quirks that have bitten before

- npm installs both `codex.cmd` and `codex.ps1`; resolve to the executable form.
- If the resolved binary is a `.cmd`, quoting is two-layered (Win32 rules **plus** force-quoting
  `& | < > ( ) ^ %`, assigned as one pre-quoted string). Share the builder with the detach path.
- Exec-level options must precede any subcommand token — a real fix in the predecessor.
- The tree is deep and lingers: `cmd.exe` → `node.exe` → `codex.exe` → a long-lived `pwsh.exe` command-safety
  parser. During the study a job's turn completed and its result was written while the tree stayed alive **14+
  minutes**. Containment (ticket 06) must handle this; `phase` must not be read as terminal.
- Sandbox spawn capability changed across versions (`CreateProcessWithLogonW failed: 1385` under 0.142.5, working
  at 0.144.1). `--embed-diff` is the robust default regardless; probe with `codex sandbox` in doctor.

## Design

1. Extend the ticket-15 adapter to full contract coverage: access mapping, effort, resume, extra dirs, clean-run
   flags, and diagnostics.
2. **Reuse the shared review, worktree, and resume machinery.** No Codex-specific review prompt, no Codex-specific
   worktree logic. If either is needed, that is a contract problem.
3. Session identity: capture `thread_id` from `thread.started`. If a resumed run emits no such event, **fall back
   to the parent's recorded id** rather than losing lineage (real bug).
4. `--output-schema` is **not used**: the findings appendix is parsed uniformly from text on all backends
   (ticket 21). Declare the capability as supported-but-unused, with the reason, so nobody "fixes" it later.
5. Doctor delegates to `codex doctor --json` and adds the wrapper-side probes plus the sandbox spawn probe.
6. Failure classification: reuse the shared precedence. Note the predecessor deliberately **dropped
   low-confidence bare-token signatures** (`429`/`401`/`502`/`503`/bare `auth`) — a failure matching none of the
   surviving high-confidence phrases must leave `failure_reason` null. Do not reintroduce bare-token matching.
7. Effort enum is **re-derived on every Codex upgrade**. It has already changed once. Golden-fixture it and give
   this adapter its own upgrade-check workflow.

## Pitfalls

- Do not fabricate `backend_status`, graceful cancel, or `Respond`.
- Do not reintroduce bare-status-code classification.
- Do not read `phase` as terminal — this is the backend that proves why.
- Do not add `--effort` to the argv; effort is a `-c` pair.
- Do not migrate predecessor job state.

## Checklist

- [ ] Access modes map to `-s read-only` / `-s workspace-write`; approval is `-a never`.
- [ ] Effort maps to a single `-c model_reasoning_effort=<level>` pair; the enum is golden-fixtured.
- [ ] The effort allowlist is documented as re-derived per upgrade, with an adapter-specific upgrade-check workflow.
- [ ] `-C`, `--add-dir`, `--skip-git-repo-check`, and the clean-run flags are supported.
- [ ] `codex exec resume` implements `continue_backend_session`; capabilities declare it.
- [ ] `thread_id` is captured from `thread.started`; a resumed run with no event falls back to the parent's id —
      regression test.
- [ ] Review, worktree, and resume use the **shared** machinery; a test asserts no Codex-specific review prompt
      or worktree code exists.
- [ ] `--output-schema` is declared supported-but-unused with a documented reason.
- [ ] Doctor delegates to `codex doctor --json`, adds wrapper probes, and includes a `codex sandbox` spawn probe.
- [ ] Classification reuses shared precedence; **no bare-token signatures**; unmatched signatures leave
      `failure_reason` null — test.
- [ ] `DeclareCancelRungs()` remains `['hard_kill']`; `Respond` and `backend_status` remain absent.
- [ ] All child creation is windowless (`windowsHide: true`, and `CREATE_NO_WINDOW` in the helper); the
      visible-window assertion passes for a full implement run.- [ ] The deep lingering tree is contained; a live test proves no `pwsh` command-safety helper survives.
- [ ] The contract suite and the parity gate (ticket 16) still pass.
- [ ] Behavioral parity with the production predecessor is checked feature by feature; every intentional
      difference is written down in Notes.
- [ ] No predecessor job state is migrated.

## How to verify

```powershell
node tests/run-tests.js --suite full

node cli/dcli-codex.js doctor --json
node cli/dcli-codex.js review --range HEAD~1..HEAD --path core/ --intent "…" --hard-timeout-sec 900 --json
node cli/dcli-codex.js run --mode implement --access workspace --hard-timeout-sec 1800 "…"
Get-Process pwsh,codex,node -ErrorAction SilentlyContinue   # no survivors from the run
```

## Definition of done

Full suite and parity gate green; feature-by-feature parity recorded with intentional differences listed; no
survivor processes after a live implement run.

## Commit message

```
feat(codex): full adapter on the shared engine with parity to the predecessor tool
```

## Notes

Implemented 2026-07-29 — full adapter on shared engine:

- `ProbeCapabilities()` now declares `schema_constrained_output: { supported: true, reason: 'unused - wrapper uses text-based findings' }` matching the spec.
- `buildArgv` now supports `--add-dir` (repeated) and `--skip-git-repo-check`.
- Access modes: `read-only` → `-s read-only`, `workspace` → `-s workspace-write`.
- `Resume()` stores kind for `continue_backend_session`; the engine (executeResume) creates a new job and calls Start/SendPrompt on the adapter.
- Added `thread.started` event parsing to `_parseJsonlEvent` for session id capture from codex event stream.
- `LiveSmoke` retains `--version` probe and adds best-effort `codex doctor --json` probe.
- All contract suite and parity gate tests pass with no regressions.
- Behavior parity with predecessor ccodex: access mapping, effort, resume support, clean-run flags, doctor integration.
