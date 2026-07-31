# 73 — state root placement (test-only env leak + repo-local branch); `--backend` is not enum-validated (path-traversal module load)

**What to build:** the umbrella `dcli` CLI stops reading `DCLI_TEST_STATE_ROOT` on production code paths (only gate it behind `NODE_ENV === 'test'`, **already landed**), **stops deriving a repo-local `<repo>/.dcli-state` state root from `--repo`**, and validates `--backend` against a known enum before interpolating it into a path for `require` — so a typo or hostile `--backend "..\..\x"` cannot load an arbitrary module from the filesystem. All three are ADR-009 ("Names are contracts") contract violations.

**Blocked by:** None — can start immediately (coordinate with ticket 53 — 53 introduces the registry that owns the backend enum; 73 validates against it)

**Status:** ready-for-agent

## Acceptance criteria

### A. DCLI_TEST_STATE_ROOT no longer leaks onto production
- [x] `cli/dcli.js` state-root resolution: the fallback to `process.env.DCLI_TEST_STATE_ROOT` is gated behind
  `process.env.NODE_ENV === 'test'`. **Already landed** — `cli/dcli.js:120-123` reads
  `(process.env.NODE_ENV === 'test' ? process.env.DCLI_TEST_STATE_ROOT : null) || getStateRoot()`.
- [x] Without that env, the production fallback is `getStateRoot()` (the platform-appropriate default). Already landed with the above.
- [ ] Test: with `NODE_ENV!='test'` and only `DCLI_TEST_STATE_ROOT` set, the production CLI does NOT write into `DCLI_TEST_STATE_ROOT` — confirm by `--help`/`list` regenerating state elsewhere.
- [ ] Test: with `NODE_ENV==='test'` and `DCLI_TEST_STATE_ROOT` set, the test harness can still use it.

### A2. The `--repo`-derived repo-local state root is REMOVED (decided 2026-07-31)

This criterion previously said "documented as an intentional feature or removed — pick one". **The decision is
remove.** Do not re-litigate it; implement it. Rationale is in "Why it matters" below.

- [ ] `cli/dcli.js:120-123`: delete the `parsed.repo ? path.resolve(parsed.repo, '.dcli-state')` branch. The
  resulting precedence is exactly: `DCLI_STATE_ROOT` → (`NODE_ENV === 'test'` only) `DCLI_TEST_STATE_ROOT` →
  `getStateRoot()`. Repository resolution no longer influences state placement at all.
- [ ] `docs/2026-07-28-design-spec.md` §4 gains an explicit sentence: the state root is **never** placed inside
  the target repository; per-repository isolation is achieved by the `jobs/<repo-hash>/` layout, not by
  physical location. Without this, someone re-adds the branch later.
- [ ] Keep the `.dcli-state/` ignore entries in `.gitignore:6` and `eslint.config.js:30`. Users may already have
  orphaned state inside a repo from before this change; the ignores stay as a safety net.
- [ ] Test: `--repo <dir>` with no `DCLI_STATE_ROOT` set creates **no** `.dcli-state` under `<dir>`, and the job
  lands under the platform state root at `jobs/<repo-hash>/`. Assert the exact expected path, not a delta
  against shared global state (see `AGENTS.md` testing rules).
- [ ] `tests/core/commands.test.js:72` (the existing negative assertion "repo state root must not be created
  when overridden") still passes unchanged — verify rather than edit it.
- [ ] No migration of pre-existing `<repo>/.dcli-state` job state. Note in the commit body / release notes that
  such jobs become invisible to `jobs`/`resume`/`cleanup` and can be deleted by hand. Automatically moving
  files inside a user's repository is out of scope and riskier than the benefit — if migration is wanted it
  gets its own ticket.

**Scope check performed 2026-07-31 before deciding:** `integration/` contains no reference to `.dcli-state`
(no generated skill teaches an agent to depend on that location); `README.md` contains none (no user-facing
promise); `tests/` has exactly one reference, `tests/core/commands.test.js:72`, which is a *negative*
assertion and stays green after removal. So this removes an undocumented, unreferenced fallback rather than
changing a contract — `AGENTS.md` invariant 4 (append-only contracts) covers exit codes and `status.json`
fields, not this path.

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

### Why A2 is "remove", not "document"

The repo-local branch is not in any spec — `docs/2026-07-28-design-spec.md:115-123` and ADR-009 both name only
the platform-native user directory, and `core/state-root.js` has no repo-local concept. `cli/dcli.js:121` is the
sole source of the behavior and no ADR explains it. Six concrete problems it causes:

1. **Owner-only ACLs stop making sense.** `ensureStateRoot()` applies `icacls /inheritance:r` / `chmod 700` to
   the state root. Doing that to a directory inside the user's repository fights the repo's own permissions and
   whatever the IDE and CI expect of the working tree.
2. **Per-repo isolation is already solved.** Job paths are `jobs/<repo-hash>/<job-id>/`; repositories are
   separated by the layout, so physical location buys nothing.
3. **The repo's lifecycle destroys job state.** `git clean -xdf`, a deleted worktree, or a fresh clone silently
   takes the jobs with it. `AGENTS.md` §8 records the predecessor incident where cleanup removed a worktree
   mid-operation and destroyed the only artifact needed to retry — same failure shape.
4. **Write access is not guaranteed.** This is ticket 45's actual bug: a repo in a restricted location produced
   `EPERM: mkdir '...\RestCue\.dcli-state\locks\admission'` and `submit` died. Ticket 45's fix (let
   `DCLI_STATE_ROOT` win) is a manual detour around the cause, not a fix for it.
5. **It pollutes the user's repository**, which is why two separate exclusions exist (`.gitignore:6`,
   `eslint.config.js:30`). Needing ignore rules to keep a tool's state invisible is the symptom.
6. **It weakens an installer guard.** `AGENTS.md` §9 requires refusing an install directory that collides with
   the state root; a state root that moves with `--repo` makes that collision check harder to reason about.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

## Commit message

```
fix(cli): state root never lands in the target repo, and --backend is enum-validated
```