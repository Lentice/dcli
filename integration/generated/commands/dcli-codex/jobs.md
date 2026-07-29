# codex jobs

Job management commands.

  dcli-codex status <job-id> [--json]
  dcli-codex list [--group <g>] [--json]
  dcli-codex wait <job-id> [--timeout-sec <n>] [--json]
  dcli-codex wait --all --group <g> [--timeout-sec <n>] [--json]

Prefer `wait --all --group` for gathering results over a hand-rolled poll loop.
