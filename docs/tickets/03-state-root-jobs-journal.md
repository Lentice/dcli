# 03 — State root, job/attempt directories, journal + status projection

**Blocked by:** 01, 02
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md) §4 (job state picture) and §7 (pitfalls 4 and 6).

---

## Purpose

Running a job against the fake adapter creates a durable, inspectable job directory whose authoritative
history is an append-only journal, and whose `status.json` is a projection derived from it that
concurrent readers can always read safely.

## Why it matters

`status.json` cannot be both the public machine-readable projection *and* the authoritative
transactional record. A reviewer flagged this directly: mixing the two means either readers see torn
state, or writers serialize behind readers. Splitting them is cheap now and very expensive later, because
every command reads the projection.

The **attempt** dimension matters for the same reason. Resume and retry must never overwrite a previous
attempt's pid, session id, logs, failure, or result — if attempts share one directory, a retry destroys
the evidence you need to explain why the first try failed.

## Facts you need

Platform state roots:

```
Windows  %LOCALAPPDATA%\delegate-cli\        config: %APPDATA%\delegate-cli\
macOS    ~/Library/Application Support/delegate-cli/
Linux    ${XDG_STATE_HOME:-~/.local/state}/delegate-cli/
```

## Design

### Layout

```
<state-root>/
├── jobs/<repo-key>/<job-id>/
│   ├── status.json          PROJECTION — atomic replace
│   ├── journal.jsonl        AUTHORITATIVE — append-only
│   └── attempts/<n>/
│       ├── prompt.md  command.json  command.txt
│       ├── result.md  findings.json
│       ├── backend-events.jsonl
│       ├── stdout.log  stderr.log  worker.log
│       └── worker-started.json  worker-complete.json
├── index/<job-id>.json      for cross-repo `list`
├── worktrees/<job-id>/
├── locks/
└── servers/<job-id>.json    per-job backend server metadata
```

- **`repo-key`** = first 12 lowercase hex chars of SHA-256 over the *normalized canonical* repository
  path. The full path is retained in `status.json`. Do **not** lowercase the path on case-sensitive
  filesystems before hashing — normalize per platform.
- **Job id** format `YYYYMMDDTHHMMSSZ-<8 random lowercase alphanumerics>`. Sortable, collision-resistant.
- A job or attempt directory is **never reused**. Creating one that exists is an error, not an overwrite.

### The journal

One JSON object per line, appended, never rewritten:

```json
{ "seq": 7, "at": "2026-07-28T08:00:12.114Z", "kind": "attempt_state_changed",
  "attempt": 1, "from": "running", "to": "done", "detail": { } }
```

`seq` is monotonic per job. Every authoritative transition goes here first, then the projection is
rewritten. That order matters: if the process dies between the two, recovery replays the journal and
regenerates a correct projection.

### The projection

`status.json` holds every field in [design spec §5](../2026-07-28-design-spec.md#5-statusjson-contract).
The fields you must not get wrong:

- `schema_version: 1`.
- `command_exit_code` and `backend_exit_code` are **separate**. Never introduce a generic `exit_code`.
- `backend_state` is an opaque object carrying **its own `schema_version`**. The engine never inspects
  its contents; recovery needs the matching adapter version to interpret it.
- `capabilities_snapshot` is written at job creation and never updated, so a later backend upgrade
  cannot retroactively change how an old job reads.
- Attempt fields: `attempt`, `attempt_id`, `attempt_state`, `execution_token`.
- Missing data is `null`, never omitted.

### Atomic write with bounded retry

Write temp → flush → close → rename. On Windows a rename can fail transiently because a reader has the
target open; retry with a short bounded backoff, then fail with the lock exit code. Do **not** loop
forever, and do **not** fall back to a non-atomic in-place write.

## Pitfalls

- Never write job artifacts with anything but the `core/fs-text.js` writers from ticket 01. BOMs break
  downstream parsers.
- Never mutate `journal.jsonl` — no compaction, no rewriting. If it needs bounding, that is a separate
  retention decision, not an in-place edit.
- `repo-key` collisions must be impossible in practice but *detectable*: if the stored full path does
  not match the current one, fail loudly rather than sharing a directory.

## Checklist

- [ ] State root discovery is platform-native and overridable by an environment variable for tests.
- [ ] `repo-key` is 12 hex chars of SHA-256 over the normalized canonical path; the full path is stored.
- [ ] A stored full path that mismatches the current one fails loudly instead of silently sharing.
- [ ] Job ids are sortable and unique; creating an existing job or attempt directory is an error.
- [ ] `journal.jsonl` is append-only, one object per line, with monotonic `seq`.
- [ ] Every authoritative transition is journaled **before** the projection is rewritten.
- [ ] `status.json` is written atomically with a **bounded** retry, then fails with the lock exit code.
- [ ] `status.json` contains every field from design spec §5 including `schema_version`, attempt fields,
      `capabilities_snapshot`, `containment`, and `backend_state` with its own `schema_version`.
- [ ] `command_exit_code` and `backend_exit_code` exist as distinct fields; no generic `exit_code`.
- [ ] A concurrency test spawns readers and a writer and proves no reader ever observes torn JSON.
- [ ] A test proves the projection can be regenerated from the journal alone.
- [ ] An append-only test loads a fixture written with an earlier field set and parses it successfully.
- [ ] Path handling is tested with spaces, non-ASCII, long paths, UNC paths, symlinks, and junctions.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

Manually: run a fake-adapter job, then open the job directory. You should be able to tell from
`journal.jsonl` alone what happened, in order.

## Definition of done

Full suite green, including the concurrent-reader and journal-replay tests.

## Commit message

```
feat: job/attempt state layout with append-only journal and atomic status projection
```

## Notes
