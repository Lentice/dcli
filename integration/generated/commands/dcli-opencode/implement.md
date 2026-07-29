# opencode implement

Run a task in an isolated git worktree.
echo "Description" | dcli-opencode run --mode implement --access workspace --hard-timeout-sec <n>
dcli-opencode diff <job-id> --stat
dcli-opencode diff <job-id>
dcli-opencode apply [--reset-author] [--message <s>] <job-id>

Never auto-apply. Always inspect diff before applying.
