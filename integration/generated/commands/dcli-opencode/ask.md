# opencode ask

Open-ended question or brainstorming session.
echo "Your question" | dcli-opencode run --hard-timeout-sec <n>

`run` is synchronous and the default mode; --hard-timeout-sec bounds it.
The outer shell or agent tool must also have a finite timeout longer than
the hard budget plus startup/cleanup slack. If it cannot, use `submit`
and collect with `wait --timeout-sec <n>` instead.
