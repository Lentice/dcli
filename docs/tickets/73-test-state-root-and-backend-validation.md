# 73 — `DCLI_TEST_STATE_ROOT` is consumed on the production CLI path; `--backend` is not enum-validated (path-traversal module load)

**What to build:** the umbrella `dcli` CLI stops reading `DCLI_TEST_STATE_ROOT` on production code paths (only gate it behind `NODE_ENV === 'test'`), and validates `--backend` against a known enum before interpolating it into a path for `require` — so a typo or hostile `--backend "..\..\x"` cannot load an arbitrary module from the filesystem. Both are ADR-009 ("Names are contracts") contract violations.

**Blocked by:** None — can start immediately (coordinate with ticket 53 — 53 introduces the registry that owns the backend enum; 73 validates against it)

**Status:** ready-for-agent

## Acceptance criteria

### A. DCLI_TEST_STATE_ROOT no longer leaks onto production
- [ ] `cli/dcli.js` state-root resolution (around line 117-118):
  ```js
  const stateRoot = process.env.DCLI_STATE_ROOT
    || (parsed.repo ? path.resolve(parsed.repo, '.dcli-state') : process.env.DCLI_TEST_STATE_ROOT || getStateRoot());
  ```
  The fallback to `process.env.DCLI_TEST_STATE_ROOT` is gated: it is only consulted when `process.env.NODE_ENV === 'test'` (or via an explicit `DCLI_TEST_*` infrastructure helper that asserts test mode).
- [ ] Without that env, the production fallback is `getStateRoot()` (the platform-appropriate default).
- [ ] The `cli/dcli.js` `--repo` branch (which currently places state INSIDE the repo at `.dcli-state`) is documented as an intentional feature or removed — pick one; ADR-009 says "state root `dcli`" (under `LOCALAPPDATA`). If state-in-repo is intentional, document it AND make `DCLI_STATE_ROOT` always win over `--repo` (already true per ticket 45's fix — verify).
- [ ] Test: with `NODE_ENV!='test'` and only `DCLI_TEST_STATE_ROOT` set, the production CLI does NOT write into `DCLI_TEST_STATE_ROOT` — confirm by `--help`/`list` regenerating state elsewhere.
- [ ] Test: with `NODE_ENV==='test'` and `DCLI_TEST_STATE_ROOT` set, the test harness can still use it.

### B. --backend enum validation
- [ ] `core/commands/index.js` `parseArgs`: `--backend <val>` is validated against a known set (the registry from ticket 53 if landed; otherwise a static `{ opencode, codex, claude, fake }` set). On unknown → exit 2 with a clear error listing allowed backends.
- [ ] `cli/dcli.js` and `core/commands/worker.js` adapter loader: the resolved `backend` is rejected if it contains path separators or `..` segments, even after enum validation (defense in depth). Use `path.basename(backend) === backend` and the enum check together.
- [ ] The shims (`dcli-codex.js`/`dcli-opencode.js`/`dcli-claude.js`) splice `--backend <name>` into argv; the bootloader then sees a double `--backend` if the user also passes one — the parser should REJECT a `--backend` set twice (today it likely silently accepts the second). Pick reject (per `AGENTS.md` "Reject ignored flags and positionals rather than silently discarding") and add a clear error.
- [ ] Test: `dcli --backend nonesuch run ...` exits 2 with "backend must be one of: opencode, codex, claude, fake".
- [ ] Test: `dcli --backend ..\\..\\foo run ...` exits 2 (defense-in-depth rejects path segments).
- [ ] Test: `dcli-codex --backend claude run ...` exits 2 (the shim's spliced `--backend codex` plus user `--backend claude` collide).
- [ ] Full suite green.

## Development guidance

- The two halves are independent; land them in one commit if you’re touching `cli/dcli.js` for both. ADR-009 §"Test-only variables": "**A test-only variable must never become an undocumented production override just because production code happens to read it.** Prefer argument injection over an environment knob — every knob is a process-global hidden input." Follow that explicitly.
- The enum set should come from `adapters/registry.js` (ticket 53) — if 53 hasn’t landed, a temporary static set in `core/commands/index.js` is fine, with a TODO note that 53 will replace it.
- The double-`--backend` detection is in `parseArgs`: when a flag is encountered that already has a value, throw exit 2. Today's parser likely overwrites silently. Look at how `--mode` is handled (single-value flags) for the model.

## Why it matters

A user (or agent, or CI shell) that has `DCLI_TEST_STATE_ROOT` set from a test run finds the umbrella `dcli` silently using the wrong state root on every production call. A `--backend` typo bypasses any validation and either fails opaquely (`ENOENT`) or, if the path resolves to an existing module, loads it. ADR-009 names are contracts; the test-only variable being read on production is exactly the violation.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

## Commit message

```
fix(cli): gate DCLI_TEST_STATE_ROOT behind test mode and validate --backend enum
```