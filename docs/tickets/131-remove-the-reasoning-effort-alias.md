# 131 — `--reasoning-effort` is a second spelling of `--effort` that nothing needs; delete it

**Status:** done
**Blocked by:** —
**Tier:** Ergonomics and doc trust. Two spellings for one setting is the drift engine that produced
ticket 128 in the first place — four documents, three stories. One flag cannot contradict itself.
**Filed from:** a maintainer decision on 2026-08-14, taken while reviewing 128. dcli has exactly one
user, who confirms no script, recipe, or saved invocation uses `--reasoning-effort`; every remaining
occurrence in this repository is either documentation or dcli's own generated skills, all of which
ship from this same commit.

---

## Symptom / Goal

`dcli-codex` and `dcli-claude` accept two flags that set the same thing:

```
dcli-claude run --effort high            # preferred spelling
dcli-claude run --reasoning-effort high  # accepted alias, identical effect
```

Ticket 128 made the two spellings tell one consistent story. This ticket removes the second spelling
entirely, so there is nothing left to keep consistent. After this ticket:

```
$ echo hi | dcli-claude run --reasoning-effort high --hard-timeout-sec 60
dcli: unknown option --reasoning-effort
# exit 2, no job created
```

The goal includes the field behind the flag. Once no flag sets `reasoningEffort`, the field is dead
weight threaded through eight `core/` modules and written into every attempt's `command.json` as a
permanent `null`. Delete it too.

## Root cause

Not a defect — a deliberate compatibility surface that has outlived its only reason. `docs/product-spec.md`
records why the name was originally backend-qualified:

> - Options whose *meaning* differs get **backend-qualified names** — `dcli-codex --reasoning-effort`,
>   `dcli-claude --reasoning-effort`, `dcli-opencode --variant` — instead of one flag with three meanings.

That principle is intact and survives this ticket untouched: `--effort` still means something different
on codex than on claude (different enums), and opencode still rejects it in favour of `--variant`. What
changes is only *which single word* spells the codex/claude knob. `--effort` wins because it is claude's
own native flag name, and because both adapters already coalesce with `effort` first.

## Binding constraints — quoted, do not go looking for them

**Invariant 4 does not block this.** Its scope, from `docs/design-spec.md` §5 and §7, is exit codes and
`status.json` fields:

> Schema version 1. Fields are **append-only** — never rename or repurpose. Missing data is `null`,
> never omitted.

> Stable and append-only. Backend-native codes … are translated, never surfaced.

No exit code changes here and no `status.json` field is renamed or repurposed. `reasoningEffort` is
**not** a `status.json` field — verify this before you start (Agent checks below) and stop if it is.
It appears in the per-attempt `command.json` artifact, which carries no append-only guarantee.

**This ticket overrides ticket 128's non-goal**, which read:

> - **Removing `--reasoning-effort`, or making it warn.** Invariant 4 is append-only and existing
>   callers and recipes use it. It stays accepted and silent.

The override and its evidence: invariant 4 does not cover CLI flags (quoted above), and the premise
"existing callers and recipes use it" is false — see **Filed from**. Do not edit ticket 128; it is a
historical record. This paragraph is the override.

**`docs/design-spec.md` §14 is a binding contract clause and its replacement text is decided here.**
Replace the backend-qualified options block, currently:

```
dcli-codex --reasoning-effort none|low|medium|high|ultra
dcli-claude   --reasoning-effort low|medium|high|xhigh|max
dcli-opencode --variant <provider-specific string>
```

with exactly (note the corrected codex enum — the old list was also wrong, and 128 settled the real one):

```
dcli-codex    --effort none|minimal|low|medium|high|xhigh|max|ultra
dcli-claude   --effort low|medium|high|xhigh|max
dcli-opencode --variant <provider-specific string>
```

**`docs/product-spec.md`'s bullet gets this replacement text:**

> - Options whose *meaning* differs get **backend-qualified names** — `dcli-codex --effort`,
>   `dcli-claude --effort`, `dcli-opencode --variant` — instead of one flag with three meanings.

**`integration/generated/**` is produced from `integration/source/**` by
`scripts/generate-integration.js`. Never hand-edit a generated file.**

## Files to read and trace first

Flag surface:

- `core/cli-args.js` — `VALUE_FLAGS` (the `'--reasoning-effort'` entry) and the
  `case '--reasoning-effort': result.reasoningEffort = val; break;` line, plus the `reasoningEffort`
  key in the `result` initializer. Removing the `VALUE_FLAGS` entry is what makes the flag land in
  `result.unknown` — trace how `unknown` produces exit 2 and confirm it does so *before* job creation.
- `cli/dcli.js` — the `--reasoning-effort <s>` help line, and **four** `reasoningEffort: parsed.reasoningEffort`
  call sites feeding run / submit / resume / review.

Adapters:

- `adapters/codex/adapter.js` — `const effort = opts.effort || opts.reasoningEffort;` in `buildArgv()`,
  the `['--reasoning-effort', request.reasoningEffort]` enum-validation pair in `ValidateRequest()`,
  the `reasoningEffort:` field in the spawn/record path, and the `@param` JSDoc.
- `adapters/claude/adapter.js` — the same four shapes.
- `adapters/opencode/adapter.js` — `ValidateRequest()` rejects `reasoningEffort` **and** `effort` in two
  near-identical branches. The `reasoningEffort` branch becomes unreachable once no flag sets it; delete
  that branch, keep the `--effort` one.
- `adapters/fake/adapter.js` — `const unsupportedByDefault = ['reasoningEffort'];`. This is a *test
  fixture* for capability rejection generally, not a claim about the real flag. Retarget it to `effort`
  rather than deleting it; `_buildValidationError()` derives the flag name from the key, so the message
  becomes `--effort is not supported by backend fake`.

Core plumbing (the field, always `null` after the flag is gone):

- `core/commands/run.js`, `submit.js`, `resume.js`, `review.js` — each destructures `reasoningEffort`
  from its options and forwards it into the request.
- `core/job-setup.js`, `core/result-artifact.js` — where it reaches `command.json`.

Tests that will go red and must be updated, not deleted:

- `tests/core/capabilities.test.js` — asserts the fake adapter's rejection message and option name, and
  calls `parseArgs(['--backend', 'fake', 'run', '--reasoning-effort'])` to prove a value flag missing its
  value is a hard error. That last one must switch to a flag that still exists (`--effort`), or it stops
  testing what it names.
- `tests/core/attempt-population.test.js`, `tests/core/attempt-driver.test.js` — assert
  `command.reasoningEffort === null` and pass `reasoningEffort: null` in fixtures.
- `tests/adapters/claude/adapter.test.js`, `tests/adapters/codex/adapter.test.js` — the 128 alias tests
  ("accepted via `--reasoning-effort`", "`--effort` wins when both supplied"). The precedence test has
  no meaning once there is one spelling; replace it, do not just delete it — see §5.
- `tests/adapters/opencode/adapter.test.js` and `live-options-review.test.js` — assert the
  `--reasoning-effort` rejection.
- `tests/integration/generate.test.js` — `'dcli-claude': ['--reasoning-effort']` in a skill-content
  expectation map.

Documents:

- `docs/design-spec.md` §14, `docs/product-spec.md`, `docs/architecture-decisions.md` (ADR-004 quotes the
  opencode rejection message verbatim), `docs/reference/cli-codex.md` (two places),
  `docs/reference/cli-claude.md` (two places), `docs/reference/cli-opencode.md`,
  `integration/source/backend-codex.md`, `backend-claude.md`, `backend-opencode.md`.

Line numbers drift; the function names and code shapes are the spec.

## What to build

### 1. Delete the flag from the parser

In `core/cli-args.js`: drop `'--reasoning-effort'` from `VALUE_FLAGS`, drop its `case`, drop
`reasoningEffort` from the `result` initializer. Nothing else in this file changes. The flag then falls
through to `result.unknown` and exits 2 with `unknown option`, before any job record exists.

### 2. Delete the field from `core/` and the CLI

`cli/dcli.js`: remove the help line and all four `reasoningEffort: parsed.reasoningEffort` arguments.
`core/commands/{run,submit,resume,review}.js`, `core/job-setup.js`, `core/result-artifact.js`: remove the
parameter and the field. `command.json` loses its permanently-`null` `reasoningEffort` key.

### 3. Collapse the adapters to one spelling

Codex and claude, in `buildArgv()`:

```js
const effort = opts.effort || opts.reasoningEffort;   // before
const effort = opts.effort;                            // after
```

and in `ValidateRequest()`, validate only `['--effort', request.effort]` against the backend's
`EFFORT_LEVELS`. Keep 128's rejection shape, `failureClass = 'usage_error'`, exit `2`, and the trailing
`'No job was created.'` exactly as they are.

opencode: delete the `request.reasoningEffort` rejection branch; keep the `--effort` one unchanged.

`adapters/fake/adapter.js`: `const unsupportedByDefault = ['effort'];`.

### 4. Rewrite the documents

Every occurrence of `--reasoning-effort` outside a ticket file is removed or rewritten. The two binding
replacements are quoted above (design-spec §14, product-spec). The rest:

- `docs/reference/cli-codex.md` — drop "`--reasoning-effort` (accepted compatibility alias)" from both
  the flag-surface paragraph and the mapping table row.
- `docs/reference/cli-claude.md` — the same, in both places.
- `docs/reference/cli-opencode.md` — the mapping row becomes "surfaced only as `dcli-opencode --variant`;
  `--effort` is rejected".
- `integration/source/backend-codex.md` and `backend-claude.md` — the capability table row becomes
  `` `--effort <level>`; enum: … ``, and the flags bullet drops the alias sentence and the
  "if both are supplied" sentence, keeping the enum-rejection sentence.
- `integration/source/backend-opencode.md` — "`--effort` is rejected before a job is created".
- `docs/architecture-decisions.md` ADR-004 — the quoted opencode error message becomes the `--effort`
  one that the adapter actually emits. ADR *reasoning* is historical and does not change; only the
  quoted output does, because a quoted string that no longer appears in the product is a lie.

Ticket 128's own file is **not** edited — it is the historical record, and this ticket's override
paragraph is where the reversal lives.

### 5. Tests

Update, do not delete:

- Replace each "accepted via `--reasoning-effort`" case with an assertion that `--reasoning-effort` is
  now an **unknown option**: exit `2`, and no job record created.
- Replace the "`--effort` wins when both supplied" precedence test with the same unknown-option
  assertion — the precedence rule no longer exists, but the fact that the old spelling is *loudly* gone
  is the thing worth pinning.
- Retarget `parseArgs(['--backend', 'fake', 'run', '--reasoning-effort'])` to `'--effort'` so it still
  tests "value flag missing its value is a hard error".
- opencode's rejection tests keep only the `--effort` case.
- `tests/integration/generate.test.js` — `'dcli-claude': ['--effort']`.
- Every legal level for each backend is still accepted via `--effort` (this is 128's coverage; it must
  survive intact).

### 6. Regenerate

`node scripts/generate-integration.js`, committed in the same commit. Re-run the installer and confirm
the installed skills byte-match the repo — an installed skill still teaching `--reasoning-effort` would
mean every future agent session learns a flag that now exits 2.

## Non-goals

- **A deprecation period, or accepting the old spelling with a warning.** There is one user and no
  external caller; a warning path is code written to serve nobody, and it keeps alive the two-spellings
  ambiguity this ticket exists to end.
- **Renaming `--variant` or unifying it with `--effort`.** ADR-004 decided they are different concepts;
  opencode's variant surface is unbounded and provider-specific, with no enum. Unrelated to this ticket.
- **Changing either backend's effort enum.** 128 settled both. The design-spec §14 codex list is
  corrected here only because it disagrees with 128's settled enum, which is a transcription fix.
- **Migrating existing job records.** Old `command.json` files keep their `reasoningEffort` key; readers
  never require it. Rewriting history for a field that was always `null` buys nothing.
- **Touching `status.json`.** The field is not there. If the implementer finds it there, stop — that is
  invariant 4 territory and this ticket has not authorised it.

## Acceptance criteria

- [ ] **A.** `--reasoning-effort` on any shim exits `2` as an unknown option and creates no job record.
- [ ] **B.** `--effort` still works on codex and claude for every documented level, and is still rejected
  by opencode with `unsupported_capability` and exit `2`.
- [ ] **C.** An out-of-enum `--effort` value is still a `usage_error` with exit `2` and no job record —
  128's behavior is unchanged.
- [ ] **D.** No occurrence of `reasoning-effort` or `reasoningEffort` remains anywhere outside
  `docs/tickets/`.
- [ ] **E.** `command.json` no longer carries a `reasoningEffort` key.
- [ ] **F.** `docs/design-spec.md` §14 and `docs/product-spec.md` carry the exact replacement text quoted
  in this ticket.
- [ ] **G.** ADR-004's quoted opencode error message matches the string the adapter actually emits.
- [ ] **H.** Installed skills byte-match `integration/generated/**`.
- [ ] **I.** No effort enum and no backend name appears in `core/` (128's invariant-1 criterion still holds).
- [ ] **Z.** `npm run check` green; the tracker table regenerated via
  `node scripts/generate-tickets-table.js` whenever this ticket's status or blockers changed;
  `README.md`, `docs/reference/*` and `integration/source/*` updated in the same commit.

## Agent checks

```bash
# PRE-FLIGHT — the premise of this ticket. reasoningEffort must NOT be a status.json field.
# If this prints anything under a status-writing path, STOP and re-read the Binding constraints.
grep -rn "reasoningEffort" core/status*.js core/job-store*.js 2>/dev/null
# expect: no output

# The spelling is gone from code and docs alike (tickets keep their history):
grep -rn "reasoning-effort\|reasoningEffort" --exclude-dir=node_modules --exclude-dir=.git \
  --exclude-dir=tickets .
# expect: no output

# The old flag is loudly rejected, before any job exists:
echo hi | node cli/dcli.js --backend claude run --repo . --reasoning-effort high --hard-timeout-sec 60; echo "exit=$?"
# expect: unknown option --reasoning-effort, "No job was created."-equivalent, exit=2

# The surviving flag still works end to end on both backends:
echo hi | node cli/dcli.js --backend codex run --repo . --effort xhigh --hard-timeout-sec 60; echo "exit=$?"
# expect: a normal run, exit=0 (or a backend-level failure — NOT a usage error)

# 128's enum validation survived the collapse:
echo hi | node cli/dcli.js --backend claude run --repo . --effort turbo --hard-timeout-sec 60; echo "exit=$?"
# expect: message naming --effort and the five legal levels, "No job was created.", exit=2

# opencode still rejects the surviving flag, and has only one rejection branch left:
grep -c "is not supported by backend opencode" adapters/opencode/adapter.js
# expect: 1

# Invariant 1 held:
grep -rn "xhigh\|reasoning_effort\|minimal" core/
# expect: no output

# Generated integration files match their sources:
node scripts/generate-integration.js --check
# expect: "All generated files are up to date."
```

## Notes

Removed the old effort alias from the parser and CLI, then deleted the now-dead `reasoningEffort`
plumbing from core requests, worker params, and `command.json`. Codex and Claude retain their validated
backend-specific `--effort` enums; opencode retains its single `--effort` rejection. The fake adapter,
tests, references, ADR text, product/design specs, integration sources, and generated skills now use only
the surviving spelling.

Direct checks passed:

- `node tests/adapters/claude/adapter.test.js`
- `node tests/adapters/codex/adapter.test.js`
- `node tests/adapters/opencode/adapter.test.js`
- `node tests/core/capabilities.test.js`
- `node tests/core/attempt-population.test.js`
- `node tests/core/attempt-driver.test.js`
- `node tests/core/setup-cleanup.test.js`
- `node tests/core/setup-failure.test.js`
- `node tests/core/cli-args.test.js`
- `node tests/integration/generate.test.js`
- Targeted ESLint, generated-artifact check, and `git diff --check` passed.
- The old alias exits `2` as an unknown flag on Claude and Codex; invalid `--effort` remains a usage
  error, and opencode still rejects `--effort` as unsupported. No occurrence of either old spelling
  remains outside `docs/tickets/`.

Per the user's instruction, the full `npm run check` was not run.
