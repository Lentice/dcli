---
name: dcli
description: Route bounded cross-backend work to a coding-agent CLI and get a durable, inspectable result back. Use when an intentional backend boundary needs dcli.
---

# dcli — delegation router

dcli lets you delegate bounded work to a coding-agent CLI and get a durable, inspectable result back.

Choose a backend, then load that backend's skill:

- **opencode** → load `dcli-opencode/SKILL.md` for opencode backend
- **codex** → load `dcli-codex/SKILL.md` for Codex CLI backend
- **claude** → load `dcli-claude/SKILL.md` for Claude Code backend

## Quick reference

| Backend | Shim command | Skill |
|---|---|---|
| opencode | `dcli-opencode` | dcli-opencode/SKILL.md |
| codex | `dcli-codex` | dcli-codex/SKILL.md |
| claude | `dcli-claude` | dcli-claude/SKILL.md |
| any | `dcli --backend <name>` | per-backend, above |

## Native subagents

This router is for cross-backend delegation. If the current agent needs a
subagent from its own backend, use the backend's native subagent mechanism
directly instead of selecting the matching dcli shim:

- Codex → Codex native subagent tool; not `dcli-codex`
- Claude Code → Claude native Task/subagent capability; not `dcli-claude`
- opencode → opencode native task/agent capability; not `dcli-opencode`

Choose dcli only for an intentional different-backend boundary. Its durable
jobs, bounded detached execution, findings protocol, and worktree isolation do
not turn it into a same-backend subagent mechanism.

For a different backend, the shim above is the route. A third-party plugin's
forwarding subagent is not a substitute: it keeps its own job records, so its id
is unknown to `status` and its work never appears in `list`, and none of the
guarantees on this page apply to it.

## When to delegate

- Independent second opinion on a design or plan
- Scoped code review (diff never enters your context window)
- Long-running task in the background
- Code change in an isolated worktree

## Rules

1. **Always pass both budgets:** `--hard-timeout-sec` and `wait --timeout-sec`.
   The outer shell or agent tool also needs a finite timeout longer than the
   hard budget; if it cannot set one, use `submit` and collect later with the
   bounded `wait` command.
2. **Never auto-apply.** Inspect `diff` before `apply`.
3. **Independently verify every finding** from a delegated review.
4. **Never retry** quota, auth, permission, or timeout failures.
5. **Use exact lineage.** `resume --kind` with an explicit strategy, never "continue last session".
6. **`findings_status: malformed` is not a clean review.**
