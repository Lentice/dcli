# 129 — every review synopsis offers `--embed-diff` as an option, but nothing can turn embedding off

**Status:** done
**Blocked by:** —
**Tier:** Ergonomics and honesty of the CLI surface. `--embed-diff` appears in every review synopsis as
if it were a choice; it is inert. The engine already supports `embedDiff: false`, but no caller can
reach it, so a reviewer who wants the backend to read the working tree itself has no way to say so.

**Filed from:** a two-auditor documentation-accuracy sweep on 2026-08-14; found by the in-session
subagent, confirmed against the code by the `dcli-codex` delegation.

---

## Symptom / Goal

`dcli --help` and all three backend skills list `--embed-diff` among the review options. Passing it
changes nothing; omitting it changes nothing. There is no `--no-embed-diff`, so the value the engine
reads is `true` under every possible invocation.

The flag is a documented option that offers no option. Either it should stop being documented as one,
or the opt-out it implies should exist. This ticket builds the opt-out, because the engine already
honors `embedDiff: false` — the only thing missing is a way to say it.

## Root cause

`core/cli-args.js` lists the flag in the valueless-flag table, whose entries can only ever set `true`:

```js
// Valueless flags: token -> result key set to true.
const BOOL_FLAGS = {
  ...
  '--embed-diff': 'embedDiff',
  ...
};
```

and `cli/dcli.js`, building the review request:

```js
embedDiff: parsed.embedDiff !== false,
```

The `!== false` was written to express "default true unless explicitly disabled" — but nothing in the
parser can ever produce `false`, so the expression is a constant. The two halves of the intended
design were never joined: the engine got its opt-out, the CLI never got the flag that reaches it.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §11, which fixes the default and states why:

> Scopes: `--staged`, `--working`, `--range <base>..<head>`, `--path <p>` (repeatable),
> `--include-untracked`, `--embed-diff`.
>
> **`--embed-diff` is the default.** The wrapper generates the exact diff itself and embeds it
> (size-capped) in the prompt. This prevents reviewing a moving target and removes any dependence on
> the backend's ability to spawn `git`.

So embedding **stays the default**. Do not invert it. The opt-out is an explicit, named,
caller-typed choice against a safe default — that is the whole reason it can exist at all.

**Invariant 4 is append-only.** `--embed-diff` keeps being accepted, keeps meaning "embed", and is
never removed; `--no-embed-diff` is added beside it.

`integration/generated/**` is produced from `integration/source/**` by
`scripts/generate-integration.js`. Never hand-edit a generated file.

## Files to read and trace first

- `core/cli-args.js` — `BOOL_FLAGS` (which can only set `true`) and the main `parseArgs()` loop. The
  new negative flag cannot simply be another `BOOL_FLAGS` entry; the loop needs a way to set `false`.
  Read the loop's structure before choosing how — the smallest change that keeps one obvious code path
  is what this ticket wants, not a new flag-kind abstraction.
- `cli/dcli.js` — the review branch, the `embedDiff: parsed.embedDiff !== false` line (which becomes
  correct rather than constant once the parser can produce `false`), and the `Options:` help block.
- The review request consumer — trace `embedDiff` from `cli/dcli.js` into `core/` to confirm what
  `false` actually does today, and that it is a supported path rather than dead code. **If it turns
  out `false` is not honored end to end, stop and say so in Notes**: the ticket's premise is that the
  engine already supports it.
- `tests/core/` — the existing `parseArgs` tests; the new precedence test belongs beside them.
- `docs/design-spec.md` §11 — the scope list gains the new flag.
- `integration/source/backend-opencode.md`, `backend-codex.md`, `backend-claude.md` — each `review`
  synopsis.
- `scripts/generate-integration.js` — the `review.md` command template carries a synopsis too; it is a
  source and must be edited.
- `docs/reference/cli-*.md` — any review synopsis or example there, including the example at
  `docs/design-spec.md` line ~860 which uses `--embed-diff` explicitly (that example stays valid).

Line numbers drift; the code shapes are the spec.

## What to build

### 1. `--no-embed-diff` in the parser

`--no-embed-diff` sets `result.embedDiff = false`. `--embed-diff` continues to set it `true`.
Neither takes a value.

**Last one wins.** If both appear, the rightmost decides. This is the ordinary shell convention and
the only rule that does not require the caller to remember an ordering.

Do not build a general negative-flag mechanism. One flag needs this; a `--no-` prefix convention for a
table with a single member is a speculative abstraction. Handle it explicitly.

### 2. `cli/dcli.js`

Help block:

```
  --embed-diff                  Embed the diff in the prompt (default)
```
→
```
  --embed-diff                  Embed the diff in the prompt (default)
  --no-embed-diff               Do not embed the diff; the backend reads the tree itself
```

The `embedDiff: parsed.embedDiff !== false` expression needs no edit — it becomes meaningful for the
first time.

### 3. `docs/design-spec.md` §11

Add `--no-embed-diff` to the scope list, and after the "**`--embed-diff` is the default**" paragraph,
one sentence:

> `--no-embed-diff` is the explicit opt-out: the prompt then describes the scope and the backend reads
> the tree itself, which reintroduces both risks named above. If both flags are supplied, the last one
> wins.

### 4. The review synopses

In the three `integration/source/backend-*.md` review blocks and in the `review.md` template inside
`scripts/generate-integration.js`, replace the `[--embed-diff]` token with `[--no-embed-diff]` —
listing the opt-out is what carries information; listing the default does not.

### 5. Tests

In the `parseArgs` tests: default is `true` with neither flag; `--embed-diff` gives `true`;
`--no-embed-diff` gives `false`; and both orderings of the two flags resolve to the rightmost.

### 6. Regenerate

`node scripts/generate-integration.js`, committed in the same commit.

## Non-goals

- **Making `false` the default.** §11 fixes embedding as the default and gives the two reasons
  (moving target, no `git` dependency in the backend). Inverting it is a contract change with real
  correctness consequences.
- **Removing `--embed-diff`.** Invariant 4 is append-only, and the flag appears in existing recipes,
  including a `docs/design-spec.md` example.
- **A general `--no-<flag>` convention in the parser.** One flag needs an opt-out. A mechanism for a
  table of one is exactly the speculative generality this repo's review record keeps rejecting.
- **Changing what a non-embedded review prompt says.** If `embedDiff: false` produces a usable prompt
  today, that is the behavior being exposed; improving it is separate work.

## Acceptance criteria

- [ ] **A.** `--no-embed-diff` is accepted by the parser and yields `embedDiff === false` in the
  review request.
- [ ] **B.** With neither flag, and with `--embed-diff`, `embedDiff` is `true`.
- [ ] **C.** When both flags are supplied, the rightmost wins, in both orders.
- [ ] **D.** `dcli --help` documents both flags, and names embedding as the default.
- [ ] **E.** `docs/design-spec.md` §11 lists `--no-embed-diff` and states the last-one-wins rule.
- [ ] **F.** Every review synopsis reachable by a user or an agent shows `[--no-embed-diff]`, not
  `[--embed-diff]`.
- [ ] **G.** `node scripts/generate-integration.js --check` reports everything up to date.
- [ ] **Z.** `npm run check` green; the tracker table regenerated via
  `node scripts/generate-tickets-table.js` whenever this ticket's status or blockers changed;
  `README.md`, `docs/reference/*` and `integration/source/*` updated in the same commit where the
  change is user-visible or agent-visible.

## Agent checks

```bash
# The opt-out exists and reaches the request (inspect via the JSON envelope or a parser unit test):
node -e "const {parseArgs}=require('./core/cli-args.js');
  const p=a=>parseArgs(['node','dcli',...a]).embedDiff;
  console.log(p(['review']), p(['review','--embed-diff']), p(['review','--no-embed-diff']),
              p(['review','--embed-diff','--no-embed-diff']), p(['review','--no-embed-diff','--embed-diff']));"
# expect: the five values to be, in order: undefined-or-true, true, false, false, true

# The default is unchanged where nothing was said:
grep -n "embedDiff" cli/dcli.js
# expect: still `embedDiff: parsed.embedDiff !== false`

# Every agent-visible synopsis advertises the opt-out, not the default:
grep -rn "\[--embed-diff\]" integration/ scripts/ docs/
# expect: no output

# The append-only promise held — the positive flag still parses:
grep -n -- "--embed-diff" core/cli-args.js
# expect: both --embed-diff and --no-embed-diff present

# No general negative-flag machinery was introduced:
grep -rn "no-embed-diff" core/cli-args.js | wc -l
# expect: a small number (a single explicit case, not a table-driven mechanism)

# Generated integration files match their sources:
node scripts/generate-integration.js --check
# expect: "All generated files are up to date."
```

## Notes

Added the explicit `--no-embed-diff` parser case. It sets `embedDiff` to `false`, while the existing
`--embed-diff` sets it to `true`; parser order gives the rightmost flag precedence and the default
remains embedding through `parsed.embedDiff !== false`. Added the help line, design-spec contract text,
review synopses, and regenerated integration skills.

Direct checks passed:

- `node tests/core/cli-args.test.js`
- `node tests/core/review.test.js`
- Parser checks covered default, both flags, and both ordering cases.
- `node scripts/generate-integration.js --check`, targeted lint, and `git diff --check` passed.
- No review synopsis under `integration/`, `scripts/`, or `docs/` still advertises `[--embed-diff]`.

Per the user's instruction, the full `npm run check` was not run.
