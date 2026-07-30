# 50 — Production default state root is `<platform-root>/test`

**What to build:** a production `dcli` invocation with no `DCLI_STATE_ROOT` and no `--repo` writes job
state under the real platform state root (`<LOCALAPPDATA>/dcli` on Windows, etc.), not under a `…/test`
subpath that real jobs can silently land in.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] The bare default state root (no `DCLI_STATE_ROOT`, no `--repo`) is the platform state root returned
      by `core/state-root.js` `getStateRoot()`, with no `/test` suffix.
- [ ] The `…/test` directory is reserved for the test harness only, gated by an explicit test-only signal
      (e.g. `DCLI_TEST_STATE_ROOT` or the test runner's own temp dir), never selected by production
      default logic.
- [ ] Ticket 45's contract is preserved: `DCLI_STATE_ROOT` still wins even when `--repo` is supplied, and
      `--repo` still selects `<repo>/.dcli-state`. Only the bare default changes.
- [ ] Regression test: invoking the dispatcher with neither `DCLI_STATE_ROOT` nor `--repo` (with the
      test-only root redirected) produces a state-root path equal to `getStateRoot()`, not
      `getStateRoot()/test`; verify no production code path selects a `test` child.
- [ ] Full suite green; existing tests that depended on the `test` suffix are routed through the
      test-only mechanism instead.

## Notes

`cli/dcli.js:117-118` resolves the state root as:

```js
const stateRoot = process.env.DCLI_STATE_ROOT
  || (parsed.repo ? path.resolve(parsed.repo, '.dcli-state') : path.join(getStateRoot(), 'test'));
```

Ticket 45 fixed `DCLI_STATE_ROOT` losing to `--repo`, but left the bare default as `…/test`. The shims
(`dcli-opencode`/`dcli-codex`/`dcli-claude`) don't set a root either, so a real `dcli-opencode status`
issued bare from a non-repo cwd would read/write `…/dcli/test`. A `test`-named state root is a dev
placeholder leaks and can collide with the test harness; per ADR-009 names are contracts, and `test` is
not a production state-root name.