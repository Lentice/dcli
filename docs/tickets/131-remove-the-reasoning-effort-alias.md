# 131 — `--reasoning-effort` is a second spelling of `--effort` that nothing needs; delete it

**Status:** done
**Blocked by:** —
**Tier:** Ergonomics and doc trust. Two spellings for one setting is the drift engine that produced
ticket 128 in the first place — four documents, three stories. One flag cannot contradict itself.
**Filed from:** a maintainer decision on 2026-08-14, taken while reviewing 128, and verified by a
`dcli-codex` audit of the full parser option surface the same day. dcli has exactly one user, who
confirms that **no script, recipe, or saved invocation of theirs** uses `--reasoning-effort`, and who
will reinstall the skills from this commit. (The flag is of course still wired through the parser, the
CLI, four adapters, eight `core/` modules and ~14 test files — that wiring is precisely what this
ticket deletes.)

**Audit result, so the implementer does not re-derive it:** across all 37 option spellings the parser
accepts, `--effort` / `--reasoning-effort` is the **only** pair that sets the same thing, and there is
**no** option that is accepted but never consumed. `--embed-diff` / `--no-embed-diff` write one key with
opposite values, and `--working` / `--staged` / `--range` select three different review scopes; neither
is an alias. The shims (`cli/dcli-{codex,claude,opencode}.js`) add no options of their own — each only
injects `--backend <b>`. So this ticket is the whole job, not the first of a series.

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
Unknown flag: --reasoning-effort
# exit 2, no job created
```

That message is the parser's existing unknown-flag error, quoted exactly. Do not invent a new one.

The goal includes the field behind the flag. Once no flag sets `reasoningEffort`, the field is dead
weight threaded through eight `core/` modules and written as a permanent `null` into **two** persisted
artifacts — every attempt's `command.json`, and every background job's `params.json`. Delete it too.

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
  `case '--reasoning-effort': result.reasoningEffort = val; break;` line. There is **no**
  `reasoningEffort` key in the `result` initializer — do not go looking for one. Removing the
  `VALUE_FLAGS` entry makes the flag an unknown flag, which the parse loop **throws** on directly
  (`throw new Error('Unknown flag: ' + tok)`); `result.unknown` is initialized and never written or
  read, so it is not part of this path. `cli/dcli.js`'s top-level catch prints `err.message` and exits
  `2`, before any job record exists.
- `cli/dcli.js` — the `--reasoning-effort <s>` help line, and **four** `reasoningEffort: parsed.reasoningEffort`
  call sites feeding run / submit / resume / review.

Adapters:

- `adapters/codex/adapter.js` — four shapes: the `@param` JSDoc, `const effort = opts.effort ||
  opts.reasoningEffort;` in `buildArgv()`, the `['--reasoning-effort', request.reasoningEffort]`
  enum-validation pair in `ValidateRequest()`, and the `reasoningEffort:` field in the spawn/record path.
- `adapters/claude/adapter.js` — only **two** shapes, not four: the `['--reasoning-effort',
  request.reasoningEffort]` validation pair, and `request.effort || request.reasoningEffort || undefined`
  on the spawn path. Claude's `buildArgv()` already reads `opts.effort` alone, and has no
  `reasoningEffort` JSDoc.
- `adapters/opencode/adapter.js` — `ValidateRequest()` rejects `reasoningEffort` **and** `effort` in two
  near-identical branches. The `reasoningEffort` branch becomes unreachable once no flag sets it; delete
  that branch, keep the `--effort` one.
- `adapters/fake/adapter.js` — `const unsupportedByDefault = ['reasoningEffort'];`. This is a *test
  fixture* for capability rejection generally, not a claim about the real flag. Retarget it to `effort`
  rather than deleting it; `_buildValidationError()` derives the flag name from the key, so the message
  becomes `--effort is not supported by backend fake`.

Core plumbing — **eight** modules, and the field reaches **two** persisted artifacts, not one:

- `core/commands/run.js`, `submit.js`, `resume.js`, `review.js` — each destructures `reasoningEffort`
  from its options and forwards it into the request. `submit.js` additionally persists it into
  **`params.json`**, the background-job parameter file.
- `core/commands/worker.js` — reads `reasoningEffort` back out of `params.json`, hands it to the
  adapter's `ValidateRequest()`, and passes it on to `command.json` persistence. **Easy to miss: the
  worker is the consumer that makes the `params.json` copy load-bearing.**
- `core/job-setup.js`, `core/result-artifact.js` — where it reaches `command.json`.

Tests that will go red and must be updated, not deleted:

- `tests/core/capabilities.test.js` — asserts the fake adapter's rejection message and option name, and
  calls `parseArgs(['--backend', 'fake', 'run', '--reasoning-effort'])` to prove a value flag missing its
  value is a hard error. That last one must switch to a flag that still exists (`--effort`), or it stops
  testing what it names.
- `tests/core/attempt-population.test.js`, `tests/core/attempt-driver.test.js` — assert
  `command.reasoningEffort === null` and pass `reasoningEffort: null` in fixtures.
- `tests/core/worker-hard-timeout.test.js`, `worker-cancel-watcher.test.js`,
  `hard-timeout-tree-kill.test.js`, `setup-cleanup.test.js`, `setup-failure.test.js` — all carry
  `reasoningEffort` in their `params.json` / request fixtures. These are the ones a search restricted to
  the obvious files will miss.
- `tests/adapters/claude/adapter.test.js`, `tests/adapters/codex/adapter.test.js` — the 128 alias tests
  ("accepted via `--reasoning-effort`", "`--effort` wins when both supplied"). The precedence test has
  no meaning once there is one spelling; replace it, do not just delete it — see §5.
- `tests/adapters/opencode/adapter.test.js` and `live-options-review.test.js` — assert the
  `--reasoning-effort` rejection.
- `tests/integration/generate.test.js` — `'dcli-claude': ['--reasoning-effort']` in a skill-content
  expectation map.
- `tests/core/cli-args.test.js` — its unknown-flag test is the **only** place acceptance criterion **A**
  can actually be proven. No adapter unit test can show that the CLI boundary rejects a removed flag; add
  the case here.

Documents:

- `docs/design-spec.md` §14, `docs/product-spec.md`, `docs/architecture-decisions.md` (ADR-004 quotes the
  opencode rejection message verbatim), `docs/reference/cli-codex.md` (two places),
  `docs/reference/cli-claude.md` (two places), `docs/reference/cli-opencode.md`,
  `integration/source/backend-codex.md`, `backend-claude.md`, `backend-opencode.md`.

Line numbers drift; the function names and code shapes are the spec.

## What to build

### 1. Delete the flag from the parser

In `core/cli-args.js`: drop `'--reasoning-effort'` from `VALUE_FLAGS` and drop its `case`. Nothing else
in this file changes. The flag is then an unknown flag and the parse loop throws
`Unknown flag: --reasoning-effort`, which `cli/dcli.js` prints and exits `2` on, before any job record
exists. That exact string — not `dcli: unknown option` — is what the tests must assert.

### 2. Delete the field from `core/` and the CLI

`cli/dcli.js`: remove the help line and all four `reasoningEffort: parsed.reasoningEffort` arguments.
`core/commands/{run,submit,resume,review}.js`, `core/commands/worker.js`, `core/job-setup.js`,
`core/result-artifact.js`: remove the parameter and the field. Both `params.json` (written by `submit`,
read by `worker`) and `command.json` lose their permanently-`null` `reasoningEffort` key.

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

- Delete each "accepted via `--reasoning-effort`" case and each "`--effort` wins when both supplied"
  precedence case from the adapter tests. They test a rule that no longer exists, and an adapter unit
  test **cannot** stand in for the replacement — adapters never see argv.
- Add the replacement in `tests/core/cli-args.test.js`, beside its existing unknown-flag case:
  `parseArgs([... , '--reasoning-effort', 'high'])` throws `Unknown flag: --reasoning-effort`. This is
  the one test that proves acceptance criterion **A**.
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
- **Migrating existing job records.** Old `command.json` and `params.json` files keep their
  `reasoningEffort` key; readers never require it. Rewriting history for a field that was always `null`
  buys nothing. (A job submitted before this commit and run by a worker after it is the one edge case:
  the worker simply ignores the extra key.)
- **The slash-command names that differ from their CLI subcommands** — `:jobs`→`list`, `:ask`→`run`,
  `:implement`→`run --mode implement`. The codex audit flagged these as alias-shaped. They are a
  deliberate skill-surface convenience, documented as a mapping table in the generated skills, and they
  are not option spellings; nothing about them contradicts itself. Out of scope, and not a follow-up.
- **Touching `status.json`.** The field is not there. If the implementer finds it there, stop — that is
  invariant 4 territory and this ticket has not authorised it.

## Acceptance criteria

- [ ] **A.** `--reasoning-effort` on any shim fails with `Unknown flag: --reasoning-effort`, exits `2`,
  and creates no job record — asserted at the parser boundary in `tests/core/cli-args.test.js`.
- [ ] **B.** `--effort` still works on codex and claude for every documented level, and is still rejected
  by opencode with `unsupported_capability` and exit `2`.
- [ ] **C.** An out-of-enum `--effort` value is still a `usage_error` with exit `2` and no job record —
  128's behavior is unchanged.
- [ ] **D.** No occurrence of `reasoning-effort` or `reasoningEffort` remains anywhere outside
  `docs/tickets/`.
- [ ] **E.** Neither `command.json` nor `params.json` carries a `reasoningEffort` key for a newly
  created job.
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
# The codex audit of 2026-08-14 confirmed this against _defaultStatus() in core/job-store.js;
# re-run it anyway, and if it prints anything, STOP and re-read the Binding constraints.
grep -rn "reasoningEffort" core/status*.js core/job-store*.js 2>/dev/null
# expect: no output

# The worker path — the copy most likely to be left behind:
grep -rn "reasoningEffort" core/commands/worker.js core/commands/submit.js
# expect: no output

# The spelling is gone from code and docs alike (tickets keep their history):
grep -rn "reasoning-effort\|reasoningEffort" --exclude-dir=node_modules --exclude-dir=.git \
  --exclude-dir=tickets .
# expect: no output

# The old flag is loudly rejected, before any job exists:
echo hi | node cli/dcli.js --backend claude run --repo . --reasoning-effort high --hard-timeout-sec 60; echo "exit=$?"
# expect: exactly "Unknown flag: --reasoning-effort", exit=2, and `dcli-claude list` unchanged

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

Follow-up regression coverage added on 2026-08-14: `tests/core/cli-args.test.js` now pins the removed
`--reasoning-effort` spelling at the parser boundary. The dedicated ticket-131 case passes only when
`parseArgs(['--backend', 'fake', 'run', '--reasoning-effort', 'high'])` throws exit `2` with the exact
message `Unknown flag: --reasoning-effort`. This is intentionally separate from the generic
`--bogus-flag` case so adding the old spelling back to `VALUE_FLAGS` cannot stay green. The focused test
completed with exit `0` and printed:

```
PASS: ticket 131 removed --reasoning-effort flag stays rejected
```

The non-live Agent checks produced:

```
# reasoningEffort under core status/job-store paths
# no output (rg exit 1: no matches)

# old spellings repo-wide, excluding node_modules, .git, docs/tickets, and .tmp-test
.\tests\core\cli-args.test.js:89:// 6. Ticket 131 deliberately removed --reasoning-effort; keep the old flag
.\tests\core\cli-args.test.js:94:    parseArgs(['--backend', 'fake', 'run', '--reasoning-effort', 'high']);
.\tests\core\cli-args.test.js:95:    assert.fail('Should have thrown for removed --reasoning-effort flag');
.\tests\core\cli-args.test.js:97:    assert.strictEqual(err.exitCode, 2, 'removed --reasoning-effort must exit 2');
.\tests\core\cli-args.test.js:98:    assert.strictEqual(err.message, 'Unknown flag: --reasoning-effort',
.\tests\core\cli-args.test.js:102:console.log('PASS: ticket 131 removed --reasoning-effort flag stays rejected');

# old flag rejected before backend execution
Unknown flag: --reasoning-effort
exit=2

# invalid Claude effort enum
--effort must be one of low, medium, high, xhigh, max for backend claude. No job was created.
exit=2

# opencode rejection branch count
1

# xhigh|reasoning_effort|minimal under core
# no output (rg exit 1: no matches)

# generated integration check
All generated files are up to date.
exit=0
```

Deviation: the ticket's repo-wide grep required the additional `--exclude-dir=.tmp-test` exclusion;
without it, old test-run scratch artifacts make the check meaningless. Even with that exclusion, the
new acceptance-A regression test is now the only source-tree match, so the check's original "no output"
expectation and criterion D need to allow the deliberate parser-boundary test. The live Codex
`--effort xhigh` check was not run because it requires a live backend. A red phase was not manufactured:
the implementation already rejects the removed flag, and this follow-up forbids changing `core/` merely
to make the new regression test fail first.

`npm run check` was run and failed for an unrelated environment reason; dependencies are not installed
in this worktree, so ESLint is unavailable. Its output was:

```
npm notice run dcli@0.0.0 check
npm notice run npm run lint && npm run test:full
npm notice run dcli@0.0.0 lint
npm notice run eslint .
'eslint' is not recognized as an internal or external command,
operable program or batch file.
```
