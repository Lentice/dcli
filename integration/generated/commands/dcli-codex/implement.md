# codex implement

Run a task in an isolated git worktree.
echo "Description" | dcli-codex run --mode implement --access workspace --hard-timeout-sec <n>
dcli-codex diff <job-id> --stat
dcli-codex diff <job-id>
dcli-codex apply [--reset-author] [--message <s>] [--allow-untracked] <job-id>

Never auto-apply. Always inspect diff before applying.
