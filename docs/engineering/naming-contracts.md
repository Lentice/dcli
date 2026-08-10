# Names are contracts (ADR-009)

Read this before adding or renaming any identifier that is persisted, parsed, or discovered by path.

The family is **`dcli`**: umbrella `dcli`, shims `dcli-codex` / `dcli-opencode` / `dcli-claude`, state
root `dcli`, policy `.dcli/policy.json`, marker `<!-- dcli:findings -->`, environment prefix `DCLI_`, and
`status.json.backend` values `codex` / `opencode` / `claude`.

- **The predecessor `ccodex` is untouchable.** It is installed, working, and stays that way. Never install
  over its command, skill, commands, rule, or state root. The failure this prevents is invisible: skill
  installation and `PATH` resolution select independently, so an agent can read one generation's
  instructions while running the other generation's binary, and the call still looks valid.
- **Every identifier above is persisted, parsed, or discovered by path — so it is already a contract.**
  Only help text and display names are soft. Never reuse a stable identifier for a new meaning.
- **`backend` values are opaque adapter IDs owned by us**, not vendor names. Need richer identity? Add a
  field; never change the enum.
- **`backend_exit_code` and `command_exit_code` stay distinct fields.** Never collapse them into a
  generic `exit_code` — the two answer different questions, and merging them cannot be undone once
  callers parse the merged field.
- **Environment variables have declared classes.** Runtime `DCLI_WORKER` / `DCLI_DEPTH` / `DCLI_STATE_ROOT` /
  `DCLI_BACKEND` / `DCLI_JOB_ID`; test-only `DCLI_TEST_*`. **A test-only variable must never become an
  undocumented production override just because production code happens to read it.** Prefer argument
  injection over an environment knob — every knob is a process-global hidden input.
- `OPENCODE_SERVER_PASSWORD` is **not ours to name** — opencode requires it. Generate per job, keep it in
  memory only long enough to build the child environment, never mirror it into a `DCLI_*` variable, and
  redact it everywhere.
