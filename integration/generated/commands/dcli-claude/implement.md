# claude implement

Run a task in an isolated git worktree.
echo "Description" | dcli-claude run --mode implement --access workspace --hard-timeout-sec <n>
dcli-claude diff <job-id> --stat
dcli-claude diff <job-id>
dcli-claude apply [--reset-author] [--message <s>] [--allow-untracked] <job-id>

Never auto-apply. Always inspect diff before applying.
