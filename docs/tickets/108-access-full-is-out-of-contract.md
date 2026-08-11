# 108 — `--access full` is accepted, undocumented, and means three different things per backend

**Status:** ready
**Blocked by:** —
**Tier:** One shared flag with a silently different security posture per backend is exactly what
ADR-004's "shared options mean the same thing" rule exists to prevent — and opencode's `full`
grants access outside the selected repository, which §12 forbids.
**Filed from:** 2026-08-11 dual-backend audit (claude F-2; re-verified against the tree at
`51e2d35`)

---

## Symptom / Goal

`dcli run --access full` (and `submit --access full`) is accepted by the parser, documented
nowhere, and delivered differently per backend:

- **opencode** (`adapters/opencode/adapter.js:277`): `case 'full': return [{ permission: '*',
  pattern: '*', action: 'allow' }];` — unrestricted, **including `external_directory`**, because
  unlike the `workspace` case (`:281-282`) there is no external-directory deny.
- **codex** (`adapters/codex/adapter.js:300-301`): `const sandbox = access === 'workspace' ?
  'workspace-write' : 'read-only';` — `full` silently runs **read-only**.
- **claude** (`adapters/claude/adapter.js:191-192`): `access === 'workspace' ? 'acceptEdits' :
  'auto'` — `full` silently runs read-only again.

The parser accepts it (`core/cli-args.js:176-183`, list includes `'full'`), the error message
offers it, and nothing in `README.md`, `integration/source/`, or `docs/reference/` mentions it.
The contract lists only two values: `docs/design-spec.md` §16: "Access: `read-only`, `workspace`."

A user who passes `--access full` therefore gets, without any indication: unrestricted repository-
**and**-external access on opencode, or a silent downgrade to read-only on codex/claude — where a
job that needed write access fails in a way the user cannot explain from the flags they passed.

## Root cause

The parser's accepted set drifted ahead of the contract and of two of three adapters. There is no
parity gate tying the parser's accepted values to the adapters' handling, so the drift was
invisible on green.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §16: "Access: `read-only`, `workspace`. `review` is always `read-only`;
`brainstorm`/`test` default to `read-only` and require an explicit `--access workspace`;
`implement` requires `workspace` but only inside its worktree. **No mode grants access outside the
selected repository/worktree.**"

## Files to read and trace first

- `core/cli-args.js:176-183` — the accepted set and the error message.
- `adapters/opencode/adapter.js:274-295` — `_buildPermissionRuleset`: `full` (`:277`), `workspace`
  (`:279-286`), `read-only` (`:287-293`). Also where `_accessMode` is set from the request.
- `adapters/codex/adapter.js:114-133,300-305` — sandbox mapping; the comment at `:114-124`
  explains why `-s` and `-c sandbox_mode=` both exist.
- `adapters/claude/adapter.js:191-199` — permission-mode mapping.
- `core/commands/worker.js:128-135` and `core/commands/attempt-driver.js` validation calls — the
  `access` values handed to `ValidateRequest`.
- `tests/adapters/*` — existing ValidateRequest coverage to extend with the parity test.
- Grep for `'full'` across `core/ adapters/ cli/ integration/ docs/` to confirm nothing else
  depends on it before deleting.

## What to build

1. **Remove `'full'` from the accepted set** in `core/cli-args.js:177`, and update the error
   message at `:178` to list only `read-only` and `workspace`. Passing `--access full` now exits 2
   with a message naming the two valid values — honest, contract-true, and uniform across
   backends.
2. **Delete the `'full'` case** from `_buildPermissionRuleset` in the opencode adapter. Do not
   leave a fall-through or an unreachable case: the adapter should throw on an unknown access
   value (the switch's default already does — verify) so an out-of-contract value can never be
   silently granted a ruleset.
3. **Add a parity gate test** (in `tests/adapters/`): enumerate the parser's accepted `--access`
   values (`read-only`, `workspace`) and assert every adapter's `ValidateRequest` accepts each with
   the same meaning (opencode ruleset, codex sandbox, claude permission mode). This test is what
   would have caught the drift; make it structural (derive the accepted set from
   `core/cli-args.js` rather than hard-coding it, so the gate cannot rot).
4. **Docs check.** Grep `docs/reference/`, `integration/source/`, `README.md` for `full` — if any
   copy teaches `--access full`, fix it in the same commit. (Verified at ticket time: none do.)

## Non-goals

- **No new `full` semantics.** Spec'ing a third mode and implementing it in all three adapters is
  a product decision this ticket deliberately does not make; the audit's other option (remove) is
  chosen because §16 lists two values and nothing ships or documents a third.
- **No change to `read-only`/`workspace` behavior.**
- **No change to `status.json` `access` values** — only `read-only`/`workspace` were ever valid.

## Acceptance criteria

- [ ] **A.** `--access full` exits 2 with a message naming `read-only` and `workspace`, on every
  command that takes `--access`.
- [ ] **B.** The opencode adapter has no `'full'` branch anywhere and throws on any access value
  that is not `read-only` or `workspace`.
- [ ] **C.** The parity gate test derives the accepted set from `core/cli-args.js` and passes for
  all three adapters.
- [ ] **Z.** `npm run check` green; the tracker table regenerated via
  `node scripts/generate-tickets-table.js`; `README.md`, `docs/reference/*` and
  `integration/source/*` updated in the same commit if any of them mentions `full`.

## Agent checks

```bash
# What this proves: the parser rejects the removed value at the argument boundary.
node cli/dcli.js run --access full --backend opencode -- "ping"
# expect: exit 2, message naming "read-only" and "workspace"; no job created

# What this proves: no adapter branch on 'full' remains.
rg -n "'full'" core/ adapters/ cli/
# expect: (nothing)

# What this proves: the parity gate exists and derives from the parser.
rg -n "parity|accepted.*access|read-only.*workspace" tests/adapters/
# expect: the gate test, enumerating from cli-args
```

## Notes

(Left empty by the author. The implementer fills it in: what was changed and where, build and suite
results, the Agent checks' actual output, any deviation from this ticket and why, and anything
discovered that contradicts the docs.)
