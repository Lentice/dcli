# Repository guidelines — dcli

This file loads in every session, so it holds only what every task needs: what the project is, the rules
that are never negotiable, and where to find everything else. Load the linked documents when your task
touches their subject — not before.

## What this is

`dcli` lets an engineer in Claude Code delegate bounded work to a *different* coding-agent CLI and get a
durable, inspectable result back. Three backends behind three shim commands: `dcli-opencode` (opencode),
`dcli-codex` (Codex CLI), `dcli-claude` (Claude Code), plus `dcli --backend <b>` for scripting.

**Nothing is ever applied to the user's repository automatically.**

The initial implementation is complete. [`docs/tickets/`](docs/tickets/) is a live backlog, and its
README table is the current state of work.

```
cli/          shims: ccodex, dcli-opencode, dcli-claude, delegate
core/         the shared job engine — knows NOTHING about any backend
adapters/     codex/ opencode/ claude/ — the only backend-aware code
native/       tiny prebuilt Windows process-containment helper
integration/  source/ → generated/ Claude skills, commands, rules
tests/        core/ contract/ adapters/ integration/ fixtures/
docs/         specs, ADRs, engineering notes, CLI references, tickets
```

## The five invariants

Violating any of these is a bug, not a tradeoff.

1. **No backend-specific conditional in `core/`.** If your work seems to need one, the abstraction is
   wrong — stop and fix the contract, don't add the branch.
2. **Adapters emit facts; the engine decides state.** An adapter never declares a job finished.
3. **Nothing blocks forever.** Every wait, read, lock, HTTP call, and drain has a finite default.
4. **Contracts are append-only.** Never rename or repurpose an exit code or a `status.json` field.
5. **Backend-specific data lives only in `status.json.backend_state`**, with its own `schema_version`.

## Where to read what

`README.md` is **user-facing only**. Never use it as a technical source when developing.

| When your task is | Read |
|---|---|
| Implementing one ticket | [`docs/tickets/00-onboarding.md`](docs/tickets/00-onboarding.md) + your ticket, and nothing else unless the ticket names it |
| Writing a ticket for someone else | [`docs/tickets/AUTHORING.md`](docs/tickets/AUTHORING.md) + [`TEMPLATE.md`](docs/tickets/TEMPLATE.md) |
| Engine or process-lifecycle code | [`docs/engineering/lessons.md`](docs/engineering/lessons.md) |
| Writing or changing an adapter | [`docs/engineering/backend-pitfalls.md`](docs/engineering/backend-pitfalls.md) — traps in the backends themselves |
| Creating a process, or anything Windows-specific | [`docs/engineering/windows-spawning.md`](docs/engineering/windows-spawning.md) |
| Writing tests, or judging a green suite | [`docs/engineering/testing.md`](docs/engineering/testing.md) |
| Naming anything persisted, parsed, or found by path | [`docs/engineering/naming-contracts.md`](docs/engineering/naming-contracts.md) |
| Touching job state, exit codes, the adapter interface, deadlines | [`docs/design-spec.md`](docs/design-spec.md) — binding contracts |
| Asking why the architecture is like this, or what was rejected | [`docs/architecture-decisions.md`](docs/architecture-decisions.md), [`docs/architecture-review-record.md`](docs/architecture-review-record.md) |
| Asking what the product is for | [`docs/product-spec.md`](docs/product-spec.md) |
| Driving a backend CLI | [`docs/reference/cli-{opencode,codex,claude}.md`](docs/reference/) |
| Relying on a fact about opencode | [`docs/reference/opencode-study.md`](docs/reference/opencode-study.md) — says what is verified and what is not |

## Conventions

- **Plain JavaScript on Node.js, no build step.** JSDoc + `checkJs` for development-time typing.
  Explicit validators at every protocol boundary. `AbortController` on every HTTP call.
- **One explicit state machine** for the job lifecycle — not promise choreography spread across commands.
- **`core/*` modules must be unit-testable without a backend.**
- **Argument arrays, never shell strings.** No `cmd.exe /c`, no `/bin/sh -c` for ordinary invocation, and
  never `shell: true`. `command.txt` is quoted for humans and never executed.
- **UTF-8 without BOM** for everything the tool writes, and decode child stdout as UTF-8 explicitly.
- **Every documented recipe carries an execution budget and a wait budget.** One without them is a
  defect, even though it is "only docs". An unbounded wait once cost a user eight hours.

## Native subagent routing

`dcli` is only for intentional cross-backend delegation; its durable job guarantees do not replace a
same-backend native subagent. If the current agent needs a subagent from its own backend, use that
backend's native mechanism directly. Do not invoke the matching `dcli-*` shim for the same-backend case;
it adds an unnecessary wrapper and can create recursion.

## Every change

- **One commit per ticket.** TDD order: write failing tests → verify red → implement → verify green →
  `npm run check` → commit. **No co-author trailers.** Never commit agent scratch directories.
- **Docs ship in the same commit as the behavior**, never as a deferred task: `README.md` for user-facing
  usage, `docs/reference/*` for command and contract tables, and `integration/source/*` whenever a
  command, flag, or behavior changes that an agent should know. Re-run the installer after user-facing
  changes and verify installed copies **byte-match** the repo.
- Stale integration sources mean every future agent session is taught the old behavior. That is the most
  expensive kind of doc rot here, because it is invisible.

## When to stop and ask

- Satisfying a ticket appears to require a backend conditional in `core/`.
- A documented "verified" fact turns out to be false on your machine.
- You would need to change an exit code or a `status.json` field's meaning.
- An acceptance criterion is impossible as written.

Write what you discovered into the ticket's Notes section and say so in your report. Undocumented
discoveries are how this project rots.
