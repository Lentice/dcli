# dcli delegation rule

When a task matches the dcli delegation criteria, use the appropriate backend shim.
Always pass both budgets. Never auto-apply. Independently verify findings.
Never retry quota, auth, permission, or timeout failures.
Use exact wrapper lineage with explicit resume kinds.

Backend selection:
- For interactive-capable work: dcli-opencode
- For single-shot exec: dcli-codex
- For Claude-to-Claude: dcli-claude
