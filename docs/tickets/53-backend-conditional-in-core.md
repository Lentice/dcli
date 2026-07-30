# 53 — Backend-specific conditional inside `core/` and `cli/`

**What to build:** the names `opencode`/`codex`/`claude`/`fake` no longer appear as literals inside `core/` or `cli/` — admission limits and adapter class lookup are driven by a single ownership table that lives outside core, so adding a backend is a one-place edit and the engine has zero backend-specific branches. This is Invariant #1 in `AGENTS.md` ("No backend-specific conditional in `core/`"), currently violated in three places.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

## Acceptance criteria

- [ ] A single ownership table (e.g. a new `adapters/registry.js` or an extension of `adapters/adapter-contract.md` into code) lists, per backend id: the adapter module path, the default admission slot limit, and the exported adapter class name. It is the ONLY place in the codebase where the four backend ids appear as literals.
- [ ] `core/commands/worker.js:68` `new AdmissionController({ stateRoot, backendLimits: { opencode: 3, codex: 3, claude: 3 } })` is replaced with data read from the registry (or passed in via the `params.json` the worker already reads).
- [ ] `core/commands/worker.js:114` `mod.ClaudeAdapter || mod.CodexAdapter || mod.OpencodeAdapter || mod.FakeAdapter || mod[Object.keys(mod)[0]]` is replaced with an explicit `backendId → ClassName` lookup from the registry. The fragile order-dependent `Object.keys(mod)[0]` fallback is removed; if a module doesn’t export the class named in the registry, that’s a hard load failure.
- [ ] `cli/dcli.js:106` has the identical class-lookup issue (same literal `mod.ClaudeAdapter || mod.CodexAdapter || ...`); it is replaced with the same registry call.
- [ ] `cli/dcli.js:127` `new AdmissionController({ stateRoot, backendLimits: { opencode: 3, codex: 3, claude: 3 } })` is replaced identically.
- [ ] A `grep -rn "opencode\|codex\|claude\|fake"` over `core/` and `cli/` returns no backend-id literals in code (comments documenting behavior are fine; conditional branches are not).
- [ ] Full suite green.

## Development guidance

- **The fix is refactor-by-table, not a wide change.** Do not introduce a plugin loader. A plain `module.exports = { opencode: { module: 'adapters/opencode/adapter', class: 'OpencodeAdapter', admissionLimit: 3 }, ... }` is enough; both `cli/dcli.js` and `core/commands/worker.js` consume it.
- The admission limits must remain immutable after load (do not source from env — env is a hidden global knob, banned by ADR-009). If runtime overrides are needed later, add a declared `DCLI_ADMISSION_LIMIT_*` class with explicit documentation, but that’s a separate ticket.
- The adapter loader and the admission config should be one decision read from the registry, not two. Today the loader picks the class from `Object.keys(mod)[0]` (posix), and admission limits are a separate literal — they can drift apart.
- The `--backend` CLI flag validates against the same registry keys (see ticket 73 separately for the enum-validation half of that), so the `parseArgs` validator and the registry are consistent by construction rather than by duplication.
- **Do NOT touch the adapter contract or `backend_state`.** The `backend` value in `status.json` is opaque (ADR-009); the registry does not change it.

## Why it matters

Adding a fourth backend today requires editing three files in two layers. Forgetting any one of them silently picks the wrong adapter class (`Object.keys(mod)[0]` order falls through) or applies the wrong admission limit. The order-dependent adapter loader is the worst part: a module that happens to export a constants object first will silently become "the adapter."

## How to verify

```powershell
node tests/run-tests.js --suite full
# And confirm the grep invariant:
# (Get-Content core\*.js,cli\dcli.js -Raw) -notmatch 'opencode|codex|claude|fake'  except in comments
```

## Commit message

```
refactor: backend identity owns its limits and class name via a single registry, removing core//cli/ branch-on-backend
```