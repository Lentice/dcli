# opencode jobs

Job management commands.

  dcli-opencode status <job-id> [--json]
  dcli-opencode list [--group <g>] [--json]
  dcli-opencode wait <job-id> --timeout-sec <n> [--json]
  dcli-opencode wait --all --group <g> --timeout-sec <n> [--json]

Prefer `wait --all --group` for gathering results over a hand-rolled poll loop.

--timeout-sec is the caller wait budget, and it is separate from the execution
budget (--hard-timeout-sec) given at submit time. Documented recipes pass it
explicitly; when omitted, dcli uses a 300s fallback. Exit 20
means only that the caller budget elapsed, so the job may still be active.
With --json, inspect wait_timed_out and wait_timeout_sec, then decide from
the terminal state in `status`, never from a phase or progress signal.
