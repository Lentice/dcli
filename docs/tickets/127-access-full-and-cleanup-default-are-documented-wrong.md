# 127 — the help advertises an `--access` mode that exits 2, and never says `cleanup` with no `--older-than` deletes every age

**Status:** done
**Blocked by:** —
**Tier:** Trust and safety. One documented flag value cannot be used at all, and one documented-as-optional flag hides a destructive default: `cleanup` with no `--older-than` is a delete-everything-eligible operation and no document says so.
**Filed from:** a two-auditor documentation-accuracy sweep on 2026-08-14 (an in-session subagent and a `dcli-codex` delegation, independently, both found these).

---

## Symptom / Goal

Two independent, unrelated documentation defects, both pure-docs fixes, both in the same
"what does this flag actually do" surface.

**A. `--access full` does not exist.** `dcli --help` lists three access modes. Passing the third
one fails:

```
$ dcli --backend codex run --access full ...
Invalid --access "full": must be "read-only" or "workspace"
$ echo $?
2
```

`docs/reference/cli-opencode.md:226` makes the same false claim, describing `full` as an
"explicit named opt-in" of the wrapper.

**B. `cleanup` with no `--older-than` deletes eligible jobs of every age.** Every document lists
`--older-than` as an optional retention threshold and never states what omitting it means. It means
a threshold of zero — that is, no age filter at all. A user who reads the synopsis and runs
`dcli-codex cleanup` expecting a conservative default gets a full sweep.

## Root cause

**A.** The help string was written against opencode's *native* permission ruleset, which does have a
`full` level, rather than against the wrapper's own contract, which has two modes.

`core/cli-args.js`:

```js
const ACCESS_VALUES = Object.freeze(['read-only', 'workspace']);
```

validated in the `--access` case of the parser, throwing with `err.exitCode = 2`.

`cli/dcli.js`, in the options block:

```
  --access <s>              Access mode: read-only (default), workspace, full
```

**B.** `core/commands/cleanup.js`, in `executeCleanup()`:

```js
const ageThresholdMs = olderThan ? parseDuration(olderThan) : 0;
```

A threshold of `0` means every terminal job passes the age test. The behavior is intentional and is
not being changed by this ticket — only its absence from the documentation is the defect.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §16 fixes the access vocabulary at two values. Quoted:

> Access: `read-only`, `workspace` (`read-only` is the default). The `review` subcommand always runs
> read-only and rejects an override with exit `2` (§11). Implement-mode work executes inside a
> wrapper-owned detached worktree (§12). No mode grants access outside the selected
> repository/worktree. Network policy is separately configurable (`deny` | `ask` | `allow`).

So `full` is not a wrapper mode and **must not be added**. The fix is to the documents, in both
places.

`integration/generated/**` is produced from `integration/source/**` by
`scripts/generate-integration.js`. Never hand-edit a generated file; edit the source and regenerate
in the same commit.

## Files to read and trace first

- `cli/dcli.js` — the `Options:` block inside the help text. Two lines change here (`--access`,
  `--older-than`). Nothing else in this file.
- `core/cli-args.js` — `ACCESS_VALUES` and the `--access` validation case. Read only; this is the
  ground truth the docs must match.
- `core/commands/cleanup.js` — `executeCleanup()`, the `ageThresholdMs` line. Read only.
- `docs/reference/cli-opencode.md` — the access-mode table/paragraph around the `full` claim.
- `docs/reference/cli-codex.md`, `docs/reference/cli-claude.md`, `docs/reference/cli-opencode.md` —
  each has a `cleanup` section that needs the new sentence.
- `integration/source/backend-opencode.md`, `backend-codex.md`, `backend-claude.md` — each has a
  `cleanup` synopsis block that needs the new sentence.
- `integration/source/core.md` — the shared cleanup/preview guidance; the sentence belongs here once
  as the common rule.
- `scripts/generate-integration.js` — check whether the `cleanup.md` command template also carries a
  synopsis that needs the sentence. If it does, it is a source file and must be edited too.

Line numbers drift; the surrounding text is the spec.

## What to build

### 1. Remove `full` from the `--access` help line

In `cli/dcli.js`:

```
  --access <s>              Access mode: read-only (default), workspace, full
```
→
```
  --access <s>              Access mode: read-only (default), workspace
```

### 2. Correct `docs/reference/cli-opencode.md`

The `full` ruleset is a real opencode native capability; the defect is claiming dcli exposes it.
Replace the clause that presents `full` as a dcli opt-in with text of this substance:

> The native `full` ruleset exists in opencode but is not exposed by dcli. The wrapper contract
> accepts only `read-only` and `workspace`; `--access full` is rejected with exit `2` before a job is
> created.

Keep any surrounding description of what opencode's native levels *are* — it is accurate and useful.
Only the claim that the wrapper surfaces `full` is wrong.

### 3. Name the `cleanup` default

In `cli/dcli.js`:

```
  --older-than <Nd|Nh>      Retention threshold (positive days or hours)
```
→
```
  --older-than <Nd|Nh>      Retention threshold (positive days or hours); omitted means every eligible age
```

Add one sentence immediately after the `cleanup` synopsis in each of:
`integration/source/backend-opencode.md`, `backend-codex.md`, `backend-claude.md`,
`docs/reference/cli-opencode.md`, `cli-codex.md`, `cli-claude.md`, and once in
`integration/source/core.md` as the shared rule:

> If `--older-than` is omitted, `cleanup` includes eligible terminal jobs of **every** age. Run with
> `--dry-run` first.

**Decided, do not reopen:** `--older-than` is not being made required, and the default is not being
changed to a non-zero age. Both would silently change the meaning of existing scripts and both are
larger than a documentation defect warrants. `--dry-run` already exists as the safe preview.

### 4. Regenerate

Run `node scripts/generate-integration.js` and commit the regenerated `integration/generated/**` in
the same commit.

## Non-goals

- **Adding an `--access full` mode.** §16 fixes the vocabulary at two values, and a third mode would
  be a contract change requiring its own design decision, not a docs ticket.
- **Changing `cleanup`'s default threshold or making `--older-than` required.** See §3 — it would
  break existing callers silently, which is worse than the missing sentence.
- **Touching the effort/reasoning flag docs, the `apply` synopsis, or `--embed-diff`.** They came out
  of the same sweep but are separate tickets (128, 129, 130) because they carry code changes.

## Acceptance criteria

- [ ] **A.** `dcli --help` no longer mentions `full` as an access mode.
- [ ] **B.** No file under `docs/` or `integration/` claims dcli accepts `--access full`.
- [ ] **C.** Every `cleanup` synopsis an agent or user can reach states what omitting `--older-than`
  means, in the terms given in §3.
- [ ] **D.** `node scripts/generate-integration.js --check` reports everything up to date.
- [ ] **E.** No behavior changed: `core/cli-args.js` and `core/commands/cleanup.js` are untouched.
- [ ] **Z.** `npm run check` green; the tracker table regenerated via
  `node scripts/generate-tickets-table.js` whenever this ticket's status or blockers changed;
  `README.md`, `docs/reference/*` and `integration/source/*` updated in the same commit where the
  change is user-visible or agent-visible.

## Agent checks

```bash
# The wrapper still rejects `full` — behavior is unchanged, only the docs moved:
node cli/dcli.js --backend codex run --repo . --access full --prompt-file /dev/null; echo "exit=$?"
# expect: a message naming "read-only" or "workspace", and exit=2

# No document advertises the mode any more:
grep -rn -- "--access full" cli/ docs/ integration/ README.md
# expect: no output

# ...including the prose form in the help and the opencode reference:
grep -rn "workspace, full" cli/ docs/ integration/
# expect: no output

# The destructive default is named everywhere a cleanup synopsis lives:
grep -rln "older-than" integration/source/ docs/reference/ | xargs grep -Ln "every eligible age|every . age"
# expect: no file listed (each one carrying --older-than also carries the sentence)

# Generated integration files match their sources:
node scripts/generate-integration.js --check
# expect: "All generated files are up to date."

# This ticket did not leak into behavior:
git diff --name-only | grep -E "^(core|adapters)/"
# expect: no output
```

## Notes

Updated `cli/dcli.js` to advertise only the two supported access modes and to state that omitting
`--older-than` includes every eligible age. Corrected the opencode wrapper mapping and added the same
cleanup default warning to all backend references and integration sources; regenerated integration
artifacts. `core/cli-args.js` and `core/commands/cleanup.js` are unchanged.

Direct checks passed:

- `node cli/dcli.js --help` no longer lists `full`.
- `node cli/dcli.js --backend codex run --repo . --access full --prompt-file /dev/null` rejected with
  exit `2`.
- `node scripts/generate-integration.js --check` passed.
- Documentation scans found no claim that dcli accepts `--access full`; every cleanup synopsis now names
  the every-age default and recommends `--dry-run`.

Per the user's instruction, the full `npm run check` was not run.
