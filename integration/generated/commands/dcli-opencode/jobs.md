# opencode jobs

Job management commands.

  dcli-opencode status <job-id> [--json]
  dcli-opencode list [--group <g>] [--json]
  dcli-opencode wait <job-id> --timeout-sec <n> [--json]
  dcli-opencode wait --all --group <g> --timeout-sec <n> [--json]

Prefer `wait --all --group` for gathering results over a hand-rolled poll loop.

--timeout-sec is not optional. It is the wait budget, and it is separate from
the execution budget (--hard-timeout-sec) given at submit time: a job can hold a
finished result while its process tree is still alive, so an unbounded wait can
outlive the work by hours. When wait returns, decide from the terminal state in
`status`, never from a phase or progress signal.
