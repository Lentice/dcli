# 91 — Make the containment window test explicit about headless environments

**Tier:** Test reliability and safety-signal quality. The full suite currently fails in a legitimate non-interactive Windows session before it can evaluate descendant window ownership.
**Filed from:** 2026-08-08 full-suite audit.

---

## Symptom / Goal

`npm run test:full` passed every adapter, contract, helper, integration, and all but one core test when run with a repo-external writable temp root. `tests/core/containment.test.js` failed only because `countVisibleWindows()` returned `0` and the test asserted `Desktop should have visible windows`.

The goal is to keep the no-visible-window invariant tested without making the entire suite depend on an unrelated interactive desktop window or silently hiding the GUI-specific coverage.

## Root cause

The test unconditionally requires an external desktop condition:

```js
const desktopWindowCount = countVisibleWindows();
assert.ok(desktopWindowCount > 0, 'Desktop should have visible windows');
```

On the audit host the command also emitted `process - Alias not found.` before returning zero visible windows. The preceding containment checks all passed: helper availability, simple spawn, termination, grandchild containment, controller-death cleanup, token mismatch rejection, and fail-closed missing-helper behavior.

## Binding constraints — quoted, do not go looking for them

From `docs/engineering/testing.md`:

> **Windows Job Object containment**: grandchildren die; wrapper death kills the tree; the degraded `taskkill` fallback is exercised and marks `containment.degraded`. Plus the Unix process-group equivalents.

From `docs/design-spec.md`:

> **Hard requirement:** no process the tool creates may ever put a window on the user''s desktop — not a flash, not a console window, not a background window.

Do not weaken the production containment implementation or delete the descendant-window ownership assertion. Make the environment requirement explicit and preserve a separately runnable GUI-enabled path.

## Files to read and trace first

- `tests/core/containment.test.js` — inspect `countVisibleWindows`, `findDescendantWindows`, cleanup, and the existing live checks.
- `core/containment.js` — preserve the helper protocol, fail-closed behavior, and bounded waits.
- `native/windows-job-helper/` — understand the Windows helper's window/containment boundary before changing only test orchestration.
- `docs/engineering/testing.md` and `docs/design-spec.md` — retain the required live containment coverage.
- `tests/run-tests.js` — use its named output conventions if the environment-gated case is skipped.

## What to build

1. Detect missing PowerShell/desktop capability explicitly and report a named, observable skip for only the external-desktop prerequisite; do not convert an actual descendant-window violation into a skip.
2. Keep the existing process-tree containment checks running in headless sessions.
3. Preserve a GUI-enabled test path that exercises the visible-window detector and descendant ownership assertion, with an explicit environment/CI requirement.
4. Ensure the quick/full suite output identifies what was skipped and why.

## Non-goals

- Changing production process creation flags, helper behavior, or containment semantics.
- Treating an unknown/error result from the window query as proof of safety.
- Removing the GUI-enabled coverage or making the whole suite silently ignore it.

## Acceptance criteria

- [x] **A.** Full suite passes in a headless Windows session while naming the unavailable GUI prerequisite.
- [x] **B.** A real visible descendant window still fails the test when the GUI-enabled path runs.
- [x] **C.** Query-tool failure is distinguishable from a verified zero-window result.
- [x] **D.** `npm run lint` and all existing containment lifecycle assertions remain green.

## Agent checks

```bash
# Run the containment test in the current session.
node tests/core/containment.test.js
# expect: lifecycle checks pass; if no desktop/query tool exists, one explicit GUI prerequisite skip is printed.

npm run lint
# expect: exit code 0.

# Confirm the full test output names any skipped GUI coverage.
node tests/run-tests.js --suite full
# expect: no silent skip; every skip names the GUI prerequisite and the GUI-enabled path remains documented.
```

## Notes — 2026-08-09

Implemented by opencode as `ticket 91: make containment window test explicit about headless environments`.

- `tests/core/containment.test.js` now distinguishes failed desktop queries from verified zero-window results, keeps descendant ownership checks active when querying works, and prints explicit GUI prerequisite skips.
- Added an opt-in `DCLI_GUI_SMOKE=1` path that spawns a visible probe and asserts the detector catches it; production containment code is unchanged.
- The old PowerShell query's `$$pids`/`$$_` false-green was corrected; query failures now return `null` rather than an empty safe result.
- Containment test, GUI smoke, lint, and full suite checks passed in the worker environment; this host's pre-existing opencode password-environment failure remains unrelated.
- The worker timeout occurred after producing the result commit; only the reviewed containment test patch was retained. Its unrelated archived-doc changes were intentionally excluded.

(Left empty by the author. The implementer fills it in with changes, checks, results, deviations, and discoveries.)
