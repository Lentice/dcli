# 94 — `dcli submit --mode implement` is accepted and silently runs in `run` mode

**Status:** ready
**Blocked by:** —
**Tier:** Trust. A flag the parser validates and accepts, which then has no effect, is worse than an
unsupported flag: the caller believes an isolated worktree was created and there is nothing to `diff`.
**Filed from:** architecture review, 2026-08-10 (verified by reading the call site at `adcbac1`).

---

## Symptom / Goal

```
dcli-codex submit --mode implement --access workspace --hard-timeout-sec 1800 "…"
```

exits 0 and returns a job id. The job runs in `run` mode. `dcli diff <job-id>` finds nothing to show,
because no implement-mode worktree was ever prepared. Nothing in the output says the flag was dropped.

The same invocation through `dcli run --mode implement` works. So the flag is real, valid, and honoured
on one path only.

Goal: `submit` either honours `--mode implement` or rejects it with exit `2`. Either outcome is
acceptable; silently ignoring it is not.

## Root cause

`--mode` is parsed and validated globally, for every command:

```js
// core/commands/index.js
case '--mode':
  if (!['run', 'implement'].includes(val)) {
    const err = new Error(`Invalid --mode "${val}": must be "run" or "implement"`);
    err.exitCode = 2;
    throw err;
  }
  result.mode = val;
  break;
```

`cli/dcli.js` never passes `parsed.mode` to `executeSubmit` — the call at `cli/dcli.js:222-235` lists
`hardTimeoutSec`, `group`, `label`, `model`, `access`, `reasoningEffort`, `variant`, `effort`,
`admission`, `resumeJobId`, `stateRoot`, `backend`, and no `mode`. `executeSubmit` has no `mode`
parameter in its signature (`core/commands/submit.js:11`), and writes the value as a literal in both
places it persists it:

```js
// core/commands/submit.js — params.json, read later by the detached worker
mode: 'run',
// core/commands/submit.js — persistInitFiles commandParams
mode: 'run',
```

The detached worker reads `params.json`, so the mode is fixed to `run` before the worker ever starts.

## Binding constraints — quoted, do not go looking for them

From `docs/design-spec.md` §7:

> | `2` | Usage / validation error, incl. unsupported-option rejection (ADR-004). No job created. **The
> `--json` output must carry a distinct `failure_class`** — `usage_error` ("your syntax is wrong") and
> `unsupported_capability` ("a valid request this backend cannot serve") are different problems for an
> agent, even though they share a shell exit code.

ADR-004's rule is that unsupported options **hard-fail before any job is reserved**. Whichever branch
this ticket takes, the rejection path must run before `createJob`, not after.

From `docs/design-spec.md` §12, "Isolation for `--mode implement`": implement mode requires a prepared
worktree. If the flag is honoured, the worktree must be prepared on the submit path exactly as the
`run` path prepares it, and `diff`/`apply` must find it.

## Files to read and trace first

- `cli/dcli.js` — the `submit` case; the `executeSubmit` argument list is the defect.
- `core/commands/submit.js` — `executeSubmit()` signature, the `params.json` write, the
  `persistInitFiles` `commandParams`, and `spawnWorker`.
- `core/commands/run.js` — how the `run` path prepares an implement-mode worktree. This is the
  behaviour to either replicate or explicitly decline.
- `core/commands/worker.js` — reads `params.json`; confirm which fields it consumes for mode.
- `core/commands/diff.js`, `core/commands/apply.js` — the commands that become meaningful only if a
  worktree exists.
- `integration/source/*` and `docs/reference/cli-*.md` — the recipes that tell an agent what `submit`
  accepts. Whichever branch is taken, these change in the same commit.

## What to build

**Decide first, and record the decision in Notes.** The two acceptable branches:

### Branch A — honour it (preferred if the worktree preparation is reusable as-is)

1. `cli/dcli.js` passes `mode: parsed.mode || 'run'` to `executeSubmit`.
2. `executeSubmit` takes `mode`, prepares the implement-mode worktree on the same code path `run` uses,
   and writes the real `mode` into both `params.json` and `commandParams`.
3. `docs/reference/cli-*.md` and `integration/source/*` gain a background-implement recipe carrying
   both budgets, per the "every documented recipe carries an execution budget and a wait budget" rule.

### Branch B — reject it

1. `executeSubmit`, or the `submit` case in `cli/dcli.js`, throws exit `2` with `failure_class:
   unsupported_capability` and a message naming `run --mode implement` as the supported form —
   **before** any job id is minted or any resource acquired.
2. `docs/reference/cli-*.md` and `integration/source/*` state that `submit` is `run`-mode only, and why.

The `mode: 'run'` literals in `core/commands/submit.js` are removed either way — under Branch A they
become the parameter, under Branch B they become unreachable because the flag never gets that far.

## Non-goals

- **Auditing every other flag for the same defect.** Worth doing, but it is a different ticket; this one
  fixes the flag that is verified broken. Note any others found, in Notes.
- **Refactoring the `submit` setup path.** That is ticket 95.

## Acceptance criteria

- [ ] **A.** `dcli submit --mode implement …` either produces a job whose `diff` shows the change, or
  exits `2` — and never exits `0` having quietly run in `run` mode.
- [ ] **B.** If Branch B: no job directory, job id, admission slot or worktree exists after the
  rejection. Verified by inspecting the state root.
- [ ] **C.** If Branch A: `dcli diff <job-id>` on the submitted job returns the change, and
  `params.json` records `mode: "implement"`.
- [ ] **D.** A test covers the chosen behaviour end to end, through the CLI, asserting the exit code.
- [ ] **E.** No `mode: 'run'` literal remains in `core/commands/submit.js`.
- [ ] **Z.** `npm run check` green; `README.md`, `docs/reference/cli-*.md` and `integration/source/*`
  updated in the same commit — this is agent-visible behaviour.

## Agent checks

```bash
# The literal is gone.
grep -n "mode: 'run'" core/commands/submit.js
# expect: nothing

# The CLI passes mode through (Branch A) or rejects it (Branch B).
grep -n "mode" cli/dcli.js | grep -i submit -A2
# expect: a mode argument in the executeSubmit call, or an explicit rejection

# The generated integration copies match the sources byte for byte.
npm run check
# expect: green, including the generated-skills gate
```

## Handoff

**Extra reading, beyond `AGENTS.md` and `00-onboarding.md`** — `docs/design-spec.md` §7 (exit `2`) and
§12 (isolation for `--mode implement`); `docs/reference/cli-codex.md` / `cli-opencode.md` /
`cli-claude.md` for the recipe tables you will edit.

**Decide the branch first.** Read `core/commands/run.js`'s implement-mode worktree preparation. If it can
be called from `executeSubmit` without dragging the foreground attempt lifecycle with it, take **Branch
A**. If it cannot, take **Branch B** — a clean rejection is a correct outcome and is better than a
half-wired implement mode. Write the decision and the reason into Notes **before** you write code.

**Implementation order:**

1. Write the failing test through the CLI: `submit --mode implement`, assert the chosen outcome
   (criterion A). Verify red — today it exits 0 and runs in `run` mode.
2. Branch B only: add the rejection **before** any resource is acquired, and add the state-root
   assertion test (criterion B). ADR-004 requires the hard-fail to precede job reservation.
3. Branch A only: thread `mode` through `cli/dcli.js` → `executeSubmit` → `params.json` →
   `commandParams`, prepare the worktree, then assert `diff` returns the change (criterion C).
4. Remove the `mode: 'run'` literals.
5. Update `README.md`, `docs/reference/cli-*.md`, `integration/source/*`, then **re-run the installer**
   and confirm the installed copies byte-match the repo — `npm run check` gates this.

**Running tests while you work:**

```bash
node tests/core/submit-e2e.test.js
npm run check
```

**Traps specific to this ticket:**

- The detached worker reads `params.json`. Setting `mode` anywhere else has no effect on it.
- Under Branch B, the rejection must carry `failure_class: unsupported_capability` in `--json`, not
  `usage_error` — §7 says an agent branches on the difference.
- While tracing, check whether any *other* parsed flag is dropped at an `execute*` call site. Do not fix
  them here; list what you found in Notes so a follow-up ticket can be written.
- `--mode` is validated globally in the parser for every command. Do not make the parser
  command-specific as a shortcut; that changes error messages for other commands.

**Commit message:**

```
ticket 94: submit no longer silently ignores --mode
```

## Notes

(Left empty by the author.)
