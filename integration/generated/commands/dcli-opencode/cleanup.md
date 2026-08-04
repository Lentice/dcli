# opencode cleanup

Remove aged terminal jobs, their worktrees and git registrations,
plus orphan worktrees under the dcli state root; optionally scrub session ids.

  dcli-opencode cleanup [--older-than <Nd|Nh>] [--dry-run] [--scrub-session-ids]

Use --dry-run first: it names each worktree and reports its bytes.
Artifacts held by a reader or repository operation are named and skipped.
