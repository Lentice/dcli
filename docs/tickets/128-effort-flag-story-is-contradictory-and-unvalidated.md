# 128 — the two effort flags are documented as mutually exclusive alternatives when both work, and an out-of-enum level is silently dropped

**Status:** done
**Blocked by:** —
**Tier:** Trust and correctness. Four documents give three different stories about which effort flag a
backend accepts, and two of them are backwards. Worse, an out-of-enum effort value on claude is
silently discarded — the job runs at the model's default effort while the caller believes it asked
for something else.

**Filed from:** a two-auditor documentation-accuracy sweep on 2026-08-14 (an in-session subagent and
a `dcli-codex` delegation, independently, both found the contradiction; the silent-drop was found by
the subagent and confirmed against the code).

---

## Symptom / Goal

**A. The docs contradict each other and the code.**

`integration/source/backend-codex.md`:

> - `--effort <level>` — reasoning effort level (use instead of `--variant` or `--reasoning-effort`)

`integration/source/backend-claude.md`:

> - `--reasoning-effort <level>` — reasoning effort level (use instead of `--variant` or `--effort`)

These are opposites, and both are wrong: **both adapters accept both flags.** Only `--variant` is
rejected. Meanwhile `docs/reference/cli-codex.md` says codex effort is "surfaced as
`dcli-codex --reasoning-effort`", contradicting the codex skill file directly.

An agent reading the claude skill avoids `--effort`, which is the flag that actually takes precedence.
An agent reading the codex reference reaches for `--reasoning-effort`, which the codex skill tells it
not to use. Every one of these callers works anyway — which is exactly why the drift has survived.

**B. An invalid effort level is discarded without a word.**

```
$ echo hi | dcli-claude run --effort turbo --hard-timeout-sec 60
```
runs to completion at the model's default effort. `turbo` is never passed to the backend and no error
is raised. On codex the opposite happens: any string is forwarded verbatim as
`-c model_reasoning_effort=turbo`, and the failure, if any, surfaces from inside the backend rather
than as a usage error.

**C. opencode's rejection is under-documented.** `integration/source/backend-opencode.md` says only
that `--reasoning-effort` is unsupported. The adapter rejects `--effort` too.

## Root cause

**A.** `adapters/codex/adapter.js`, in `buildArgv()`:

```js
// Reasoning effort maps to -c model_reasoning_effort=<level>
const effort = opts.effort || opts.reasoningEffort;
if (effort) {
  argv.push('-c', 'model_reasoning_effort=' + effort);
}
```

`adapters/claude/adapter.js`, in the adapter's spawn path:

```js
effort: request.effort || request.reasoningEffort || undefined,
```

Both coalesce, `effort` first. Neither `ValidateRequest()` rejects either alias — each rejects only
`--variant`. The "use instead of" wording in the skills describes a restriction that was never
implemented, and the two skills disagree about which direction it runs in.

The adapters' own *error messages* carry the same split: codex's `--variant` rejection says
"Use `--effort`", claude's says "Use `--reasoning-effort`".

**B.** `adapters/claude/adapter.js`, in `buildArgv()`:

```js
if (opts.effort && EFFORT_LEVELS.has(opts.effort)) {
  argv.push('--effort', opts.effort);
}
```

The membership test is used as a *filter*, not as validation. A value outside the set falls through
the `if` and vanishes. `core/cli-args.js` does not validate effort at all — it only stores it:

```js
case '--reasoning-effort': result.reasoningEffort = val; break;
case '--variant': result.variant = val; break;
case '--effort': result.effort = val; break;
```

`adapters/codex/adapter.js` has no effort enum at all; the documented list
(`none, minimal, low, medium, high, xhigh, max, ultra`) exists only in prose.

## Binding constraints — quoted, do not go looking for them

**Invariant 1 (from `00-onboarding.md`, restated because this ticket will tempt you to break it):**
no backend-specific conditional in `core/`. The two backends have *different* valid effort sets —
claude has five levels, codex has eight — so the enum check **must not** move into
`core/cli-args.js`. It belongs in each adapter's `ValidateRequest()`, which is the existing
backend-aware validation seam and already throws for `--variant`.

The established rejection shape, from `adapters/opencode/adapter.js` — copy it exactly:

```js
const err = new Error(
  '--reasoning-effort is not supported by backend opencode. ' +
  'Use --variant <provider-specific-value>. ' +
  "Run 'dcli-opencode capabilities --json' for the current surface. " +
  'No job was created.'
);
err.code = 'VALIDATION_FAILED';
err.failureClass = 'unsupported_capability';
err.optionName = '--reasoning-effort';
err.backendName = 'opencode';
throw err;
```

Note `'No job was created.'` — validation runs before job creation and must keep doing so. A rejected
effort level must leave no job record behind.

An invalid *value* for a *supported* flag is a usage error, not an unsupported capability. Use
`failureClass = 'usage_error'` and exit `2` for the new enum rejections; do not reuse
`unsupported_capability`, which means "this backend has no such knob".

`integration/generated/**` is produced from `integration/source/**` by
`scripts/generate-integration.js`. Never hand-edit a generated file.

**Invariant 4 is append-only:** no exit code or `status.json` field is renamed or repurposed here, and
neither flag is removed. `--reasoning-effort` stays accepted forever.

## Files to read and trace first

- `adapters/codex/adapter.js` — `buildArgv()` (the `opts.effort || opts.reasoningEffort` coalesce) and
  `ValidateRequest()` (the `--variant` rejection, and its error message that names `--effort`).
- `adapters/claude/adapter.js` — `EFFORT_LEVELS`, the filtering `if` in `buildArgv()`, the
  `request.effort || request.reasoningEffort` coalesce, and `ValidateRequest()`.
- `adapters/opencode/adapter.js` — `ValidateRequest()`, which already rejects **both** aliases. This
  is the shape to copy and the ground truth for §5.
- `core/cli-args.js` — the three effort-ish flag cases. **Read only.** Nothing changes here.
- `tests/adapters/**` — find the existing `--variant`-rejection tests for codex and claude; the new
  enum tests belong beside them, in the same style.
- Any adapter-parity or capabilities test that asserts the supported flag surface — if
  `capabilities --json` reports effort flags, its expectations may need updating; trace it before
  editing.
- The four documents in §1–§4 below.

Line numbers drift; the function names and code shapes are the spec.

## What to build

### 1. One story, decided: `--effort` is the preferred spelling, `--reasoning-effort` is an accepted alias

Decided, do not reopen. The reasons: both adapters already coalesce with `effort` first, so `--effort`
is what actually wins when both are supplied; and claude's own native CLI flag is `--effort`. Making
codex and claude tell the same story removes a class of agent confusion that costs nothing to keep
consistent.

So, for **both** codex and claude:

- `--effort <level>` — preferred.
- `--reasoning-effort <level>` — accepted compatibility alias, same meaning.
- If both are supplied, `--effort` wins.
- `--variant` is rejected (unchanged).

And for **opencode**: `--variant` is the only reasoning knob; **both** `--effort` and
`--reasoning-effort` are rejected before a job is created (already true in code — §5 is docs only).

### 2. Rewrite the four contradictory documents

`integration/source/backend-codex.md`, capability table row and the flags bullet:

> | Effort/reasoning | `--effort <level>` (preferred) or `--reasoning-effort <level>`; enum: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |

> - `--effort <level>` — preferred spelling. `--reasoning-effort <level>` is an accepted compatibility
>   alias for the same setting; if both are supplied, `--effort` wins. `--variant` is rejected.
>   A value outside the enum is rejected with exit `2` before a job is created.

`integration/source/backend-claude.md`, the same two places, with claude's enum
(`low`, `medium`, `high`, `xhigh`, `max`) and otherwise identical wording.

`docs/reference/cli-codex.md`: "surfaced as `dcli-codex --reasoning-effort`" →
"surfaced as `dcli-codex --effort`; `--reasoning-effort` is an accepted compatibility alias".

`docs/reference/cli-claude.md`: the same correction in both places it appears (the flag-surface
paragraph and the mapping line further down).

### 3. Make claude reject an out-of-enum level instead of dropping it

In `adapters/claude/adapter.js`:

- In `ValidateRequest()`, check `request.effort` and `request.reasoningEffort` **separately** (so the
  error names the flag the caller actually typed) against `EFFORT_LEVELS`, skipping `undefined`/`null`.
  On a miss, throw in the shape quoted above with `failureClass = 'usage_error'`, exit `2`,
  `optionName` set to the flag the caller used, and a message listing the legal values and ending
  `'No job was created.'`
- In `buildArgv()`, change

  ```js
  if (opts.effort && EFFORT_LEVELS.has(opts.effort)) {
  ```
  to
  ```js
  if (opts.effort) {
  ```

  Validation has already run; the filter must not silently swallow anything a second time.

### 4. Give codex the enum it documents

In `adapters/codex/adapter.js`, add beside the existing constants:

```js
const EFFORT_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
```

and validate both aliases in `ValidateRequest()` exactly as in §3. `buildArgv()` needs no change — it
already forwards whatever survives validation.

### 5. Correct opencode's flag documentation (docs only — the code is already right)

`integration/source/backend-opencode.md`:

> - `--variant <string>` — provider-specific reasoning variant. **Both** `--effort` and
>   `--reasoning-effort` are rejected before a job is created.

`docs/reference/cli-opencode.md`: expand "never `--effort`" to
"surfaced only as `dcli-opencode --variant`; both `--effort` and `--reasoning-effort` are rejected".

### 6. Align the adapters' own `--variant` error messages with §1

Codex's already says "Use `--effort`". Change claude's from "Use `--reasoning-effort <level>`" to
"Use `--effort <level>`". Update whatever test asserts that message string.

### 7. Tests

Beside the existing `--variant` tests, for **each** of codex and claude:

- every documented legal level is accepted via `--effort`, and via `--reasoning-effort`;
- an out-of-enum value is rejected with exit `2`, `failureClass = 'usage_error'`, a message naming the
  flag the caller used, and **no job record created**;
- with both aliases supplied and different, the argv the adapter builds reflects `--effort`.

### 8. Regenerate

`node scripts/generate-integration.js`, committed in the same commit.

## Non-goals

- **Removing `--reasoning-effort`, or making it warn.** Invariant 4 is append-only and existing
  callers and recipes use it. It stays accepted and silent.
- **Moving effort validation into `core/cli-args.js`.** The valid sets differ per backend; a check
  there is a backend conditional in `core/` — invariant 1.
- **Adding effort support to opencode.** Its provider surface is `--variant`, unbounded and
  provider-specific; there is no enum to check against.
- **Changing which alias wins when both are supplied.** `--effort` already wins in both adapters;
  §1 documents the existing behavior rather than changing it.
- **Splitting the docs fix from the code fix.** They must ship together — see below.

## Acceptance criteria

- [ ] **A.** `integration/source/backend-codex.md` and `backend-claude.md` describe the same rule:
  `--effort` preferred, `--reasoning-effort` an accepted alias, `--effort` wins when both are given,
  `--variant` rejected.
- [ ] **B.** No document anywhere says to use one of the two effort flags "instead of" the other.
- [ ] **C.** `docs/reference/cli-codex.md` and `cli-claude.md` no longer present `--reasoning-effort`
  as the surfaced flag.
- [ ] **D.** An out-of-enum effort level on claude exits `2` with `usage_error`, names the flag the
  caller typed, and creates no job record.
- [ ] **E.** The same is true on codex, against the eight-level enum.
- [ ] **F.** Every legal level for each backend is still accepted through either alias.
- [ ] **G.** With both aliases supplied, the built argv carries the `--effort` value.
- [ ] **H.** opencode's docs state that both `--effort` and `--reasoning-effort` are rejected.
- [ ] **I.** No effort enum, and no backend name, appears in `core/`.
- [ ] **Z.** `npm run check` green; the tracker table regenerated via
  `node scripts/generate-tickets-table.js` whenever this ticket's status or blockers changed;
  `README.md`, `docs/reference/*` and `integration/source/*` updated in the same commit where the
  change is user-visible or agent-visible.

## Agent checks

```bash
# The contradictory instruction is gone from every source and generated document:
grep -rn "instead of .*--effort\|instead of .*--reasoning-effort" integration/ docs/
# expect: no output

# The reference docs no longer surface the alias as the primary flag:
grep -rn "surfaced as dcli-codex --reasoning-effort\|surfaced as dcli-claude --reasoning-effort" docs/
# expect: no output

# An invalid level is a usage error on claude, before any job exists:
echo hi | node cli/dcli.js --backend claude run --repo . --effort turbo --hard-timeout-sec 60; echo "exit=$?"
# expect: message naming --effort and the five legal levels, "No job was created.", exit=2

# ...and on codex, against its eight-level enum:
echo hi | node cli/dcli.js --backend codex run --repo . --reasoning-effort turbo --hard-timeout-sec 60; echo "exit=$?"
# expect: message naming --reasoning-effort and the eight legal levels, "No job was created.", exit=2

# The silent filter is gone:
grep -n "EFFORT_LEVELS.has" adapters/claude/adapter.js
# expect: matches only inside ValidateRequest, never inside buildArgv

# Invariant 1 held — no effort enum and no backend name leaked into core:
grep -rn "xhigh\|reasoning_effort\|minimal" core/
# expect: no output
grep -rn "codex\|claude\|opencode" core/cli-args.js
# expect: no output

# Generated integration files match their sources:
node scripts/generate-integration.js --check
# expect: "All generated files are up to date."
```

## Notes

Made `--effort` the documented preferred spelling for Codex and Claude while retaining
`--reasoning-effort` as an accepted alias; both adapters already gave `--effort` precedence. Claude
and Codex now validate their backend-specific enums before job creation with `usage_error`, and Claude
no longer silently drops invalid values. Opencode documentation now states that both effort aliases are
rejected. Updated the adapter variant hint, integration-generation check for intentional alias mentions,
and regenerated integration artifacts.

Direct checks passed:

- `node tests/adapters/claude/adapter.test.js`
- `node tests/adapters/codex/adapter.test.js`
- `node tests/integration/generate.test.js`
- Invalid Claude/Codex CLI effort values exit `2`, name the supplied flag, list legal levels, and say
  `No job was created.`
- Targeted ESLint, `node scripts/generate-integration.js --check`, and `git diff --check` passed.
- No effort enum or backend name was added to `core/`.

Per the user's instruction, the full `npm run check` was not run.
