# 87 — Remove unused imports from runtime modules

**Tier:** Maintainability and load hygiene. Unused runtime imports add noise and hide the import surface that future linting should verify.
**Filed from:** 2026-08-08 repository import audit.

---

## Symptom / Goal

The runtime code loads imported names that no code in the same module reads. The normal lint gate does not report them because `no-unused-vars` is intentionally disabled. Remove only the verified unused imports below while preserving behavior and all existing import paths.

## Root cause

The audit temporarily enabled the existing ESLint rule and found these runtime bindings:

```text
adapters/claude/adapter.js: fs, path, os
adapters/shared/resolve-executable.js: fs
core/cancel.js: fs
core/commands/diff.js: TERMINAL
core/commands/index.js: generateJobId, getBackendLimits
core/commands/submit.js: buildEnvelope
core/commands/worker.js: buildEnvelope
core/containment.js: EventEmitter
core/locking.js: isProcessAlive
```

`adapters/shared/resolve-executable.js` also contains a generated child-script string that declares its own `fs`; that string is not the unused host binding and must remain unchanged.

## Binding constraints — quoted, do not go looking for them

From `docs/engineering/testing.md`:

> `eslint.config.js` is **deliberately narrow** and exists for one class of defect: syntactically valid code that references a name which does not exist at runtime (`no-undef`).

> Rules that are off say why, inline. `no-fallthrough` and `no-unused-vars` are currently `'off'` with their violation counts and reasons recorded in the config. Do not silently drop a rule, and do not enable one red.

This ticket removes the listed imports; it does not enable `no-unused-vars`, change the lint policy, or change any persisted or CLI contract.

## Files to read and trace first

- `eslint.config.js` — confirm the temporary audit rule and current lint policy.
- `adapters/claude/adapter.js` — preserve the remaining process, crypto, lifecycle, and executable imports.
- `adapters/shared/resolve-executable.js` — distinguish the host `fs` binding from the `fs` name embedded in `DISCOVERY_SCRIPT`.
- `core/cancel.js`, `core/commands/diff.js`, `core/commands/index.js`, `core/commands/submit.js`, and `core/commands/worker.js` — trace command callers and preserve remaining loader, envelope, and registry exports.
- `core/containment.js` and `core/locking.js` — preserve process and lock behavior.
- `tests/adapters/**`, `tests/core/**`, and `tests/contract/**` — run the existing callers; test-only import cleanup is ticket 88.

## What to build

1. Delete exactly the unused import bindings listed above, retaining used bindings from the same declaration.
2. Do not replace imports with dynamic imports, alter CommonJS format, rename exports, or modify `DISCOVERY_SCRIPT`.
3. Keep the diff limited to runtime import declarations and necessary formatting.

## Non-goals

- Enabling `no-unused-vars` — remaining unused locals and parameters need separate review so the lint gate stays green.
- Removing unused test imports — ticket 88 keeps test cleanup independently reviewable.
- Normalizing all built-in specifiers from `fs` to `node:fs` — no defect evidence requires that style change.
- Refactoring module boundaries — the audit found no missing relative modules or import-time errors.

## Acceptance criteria

- [x] **A.** The nine runtime files contain none of the unused bindings listed in Root cause; the embedded script declarations remain intact.
- [x] **B.** `npm run lint` remains green without changing `eslint.config.js` or adding disable comments.
- [x] **C.** Existing runtime module-loading and adapter/core tests pass where the environment permits temporary directories.
- [x] **D.** No persisted field, exit code, CLI behavior, or adapter interface changes.

## Agent checks

```bash
# Confirm the targeted runtime bindings no longer occur as import declarations.
rg -n "const (fs|path|os|TERMINAL|EventEmitter|isProcessAlive)|generateJobId,|getBackendLimits|buildEnvelope" adapters/claude/adapter.js adapters/shared/resolve-executable.js core/cancel.js core/commands/diff.js core/commands/index.js core/commands/submit.js core/commands/worker.js core/containment.js core/locking.js
# expect: no targeted host-module/import declaration output; the embedded DISCOVERY_SCRIPT string is allowed.

npm run lint
# expect: exit code 0.

node -e "const fs=require('node:fs'),path=require('node:path'); for (const root of ['core','adapters']) { const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]); for (const f of walk(root).filter(f=>f.endsWith('.js'))) for (const m of fs.readFileSync(f,'utf8').matchAll(/require\\(\\s*['\"](\\.[^'\"]+)['\"]\\s*\\)/g)) { const b=path.resolve(path.dirname(f),m[1]); if (![b,b+'.js',path.join(b,'index.js')].some(p=>fs.existsSync(p))) throw new Error(`${f} -> ${m[1]}`); } } console.log('relative require targets ok')"
# expect: relative require targets ok.
```

## Notes — 2026-08-09

Implemented and committed by opencode as `ticket 87: remove unused runtime imports from nine modules` (landed commit `e31f7e7`).

Changed only import declarations in the nine runtime files named above. The host `fs` binding was removed from `resolve-executable.js`; the embedded `DISCOVERY_SCRIPT` declaration was preserved.

Checks:

- Targeted `rg` check passed.
- `npm run lint` passed.
- Relative-require integrity check passed.
- Quick tests passed except one pre-existing failure.
- Full tests passed except the known opencode password-environment assertion and the containment test requiring the native helper in the isolated worktree; both were confirmed unrelated on pristine code.

The isolated worktree required `npm ci`; its temporary check script was removed before commit. PowerShell quoting mangled the inline regex, so the same check ran from a temporary `.cjs` file.
