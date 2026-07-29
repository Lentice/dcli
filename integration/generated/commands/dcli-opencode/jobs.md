# opencode jobs

Job management commands.

  dcli-opencode status <job-id> [--json]
  dcli-opencode list [--group <g>] [--json]
  dcli-opencode wait <job-id> [--timeout-sec <n>] [--json]
  dcli-opencode wait --all --group <g> [--timeout-sec <n>] [--json]

Prefer `wait --all --group` for gathering results over a hand-rolled poll loop.
