# claude jobs

Job management commands.

  dcli-claude status <job-id> [--json]
  dcli-claude list [--group <g>] [--json]
  dcli-claude wait <job-id> [--timeout-sec <n>] [--json]
  dcli-claude wait --all --group <g> [--timeout-sec <n>] [--json]

Prefer `wait --all --group` for gathering results over a hand-rolled poll loop.
