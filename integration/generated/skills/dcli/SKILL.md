---
name: dcli
description: Route bounded delegated work to a coding-agent CLI and get a durable, inspectable result back. Use when choosing which backend shim to delegate to.
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

## When to delegate

- Independent second opinion on a design or plan
- Scoped code review (diff never enters your context window)
- Long-running task in the background
- Code change in an isolated worktree

## Rules

1. **Always pass both budgets:** `--hard-timeout-sec` and `wait --timeout-sec`.
2. **Never auto-apply.** Inspect `diff` before `apply`.
3. **Independently verify every finding** from a delegated review.
4. **Never retry** quota, auth, permission, or timeout failures.
5. **Use exact lineage.** `resume --kind` with an explicit strategy, never "continue last session".
6. **`findings_status: malformed` is not a clean review.**
