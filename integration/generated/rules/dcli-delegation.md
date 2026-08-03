# dcli delegation rule

Use dcli only for intentional cross-backend delegation.
Its durable job guarantees do not replace a same-backend native subagent.
For same-backend subagents, use the current agent backend's native subagent mechanism directly.
Do not use the matching dcli shim as a substitute for a native subagent:
- Codex native subagent → not `dcli-codex`
- Claude native Task/subagent → not `dcli-claude`
- opencode native task/agent → not `dcli-opencode`

Always pass both budgets. Never auto-apply. Independently verify findings.
The outer shell or agent tool also needs a finite timeout longer than the
hard budget; use submit plus bounded wait when it cannot set one.
Never retry quota, auth, permission, or timeout failures.
Use exact wrapper lineage with explicit resume kinds.

Backend selection:
- For a cross-backend job, choose the explicitly requested different backend and load its skill.
