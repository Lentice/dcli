# 10 — Core commands: run, submit, status, wait, read, list

**Blocked by:** 04, 07
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md) §5 (exit codes) and §7 pitfall 5, `AGENTS.md` §1 and §6.

---

## Purpose

The everyday loop works end to end against the fake adapter: run something synchronously, submit something
to the background, poll or wait for it, read its result, and find it again later.

## Why it matters

This is the surface an invoking agent actually parses. Two properties are load-bearing:

**Byte-exact stdout.** Agents consume it. The predecessor asserts stdout exactness in tests precisely
because raw backend event JSON leaking onto stdout once broke downstream parsing.

**Every automation recipe must carry a budget.** The eight-hour stall happened because a *documented recipe*
omitted a timeout. Any example you write in this ticket — README, help text, doc — carries
`--hard-timeout-sec` and a wait budget. A recipe without one is a defect.

## Design

### Commands

| Command | Behavior |
|---|---|
| `run` | synchronous; prints **only** the final result to stdout |
| `submit` | returns a job id immediately and detaches; the CLI never stays resident |
| `status <job>` | reconcile, then report, without waiting |
| `wait <job> --timeout-sec <n>` | bounded; exit `20` on caller timeout, job left active |
| `wait --all --group <g>` | one-call snapshot batch gather |
| `read <job>` | terminal job's result without waiting; exit `4` if not terminal |
| `list` | newest first; `--repo` filter; cross-repository listing |

### Prompt input

Three sources, in this precedence: `--prompt-file <path>`, piped **stdin**, positional text.

- A piped prompt must never be consumed by argument parsing. The predecessor hit this: a CLI-binding
  attribute swallowed redirected stdin and exited `2`, silently breaking `"task" | tool run`. Parse `argv`
  explicitly.
- A `--prompt-file` that is silently dropped was also a real bug. If the flag is present, it is used or it
  is an error.
- Reading stdin is **bounded** — a caller that opens a pipe and writes nothing must not hang the tool.

### The `--json` envelope

```json
{ "schema_version": 1, "job_id": "...", "backend": "...", "state": "...", "phase": "...",
  "attempt": 1, "command_exit_code": 0, "backend_exit_code": null,
  "failure_reason": null, "failure": null, "findings": null, "findings_status": null }
```

Fields are present as `null`, never omitted. `command_exit_code` matches the process exit and is distinct
from `backend_exit_code`.

### Group and label

Recorded on the job, filterable by **exact** match. `wait --all --group <g> --json` is the fan-out/gather
primitive — callers must never hand-roll a polling loop, and the docs must say so.

## Pitfalls

- Raw backend events go to `backend-events.jsonl` only. Never stdout.
- `submit` must not stay resident. Verify the parent exits while the job runs.
- Reject **valueless** flags explicitly (`--model`, `--group`, `--label`, `--timeout-sec`). Silent acceptance
  of a missing value shipped as a bug three times.
- Reject unknown flags and stray positionals rather than ignoring them.
- Validate ranges **before** unit conversion.
- Watch startup cost: the predecessor loaded every module on every invocation, ~380 ms on even `--help`.
  Dispatch help before heavyweight imports.

## Checklist

- [ ] `run` prints only the final result; a test asserts stdout is **byte-exact**.
- [ ] `run` accepts a prompt via `--prompt-file`, piped stdin, and positional text, with that precedence.
- [ ] A piped prompt is never consumed by argument parsing (regression test with redirected stdin).
- [ ] A present-but-unusable `--prompt-file` is an error, never a silent drop.
- [ ] Reading stdin is bounded; an open-but-silent pipe does not hang the tool.
- [ ] `submit` returns a job id immediately and the parent process exits while the job runs.
- [ ] `status` reconciles before reporting and never waits.
- [ ] `wait --timeout-sec` returns exit `20` on caller timeout with the job still active.
- [ ] `wait --all --group <g>` gathers a snapshot batch in one call.
- [ ] `read` returns exit `4` for a non-terminal job.
- [ ] `list` is newest-first with `--repo` filtering and cross-repository listing.
- [ ] `--json` emits the envelope with `schema_version`; all fields present, `null` when unavailable.
- [ ] Valueless flags, unknown flags, and stray positionals are all rejected with exit `2`.
- [ ] Range validation precedes conversion; out-of-range is exit `2` with no side effect.
- [ ] Every exit code in [onboarding §5](00-onboarding.md) reachable from these commands has a test.
- [ ] Every example in help text and docs includes an execution and wait budget.
- [ ] `--help` dispatches before heavyweight imports; measure and record the timing in Notes.

## How to verify

```powershell
node tests/run-tests.js --suite full
"do something" | node cli/delegate.js --backend fake run --hard-timeout-sec 60
node cli/delegate.js --backend fake submit --hard-timeout-sec 300 --group demo
node cli/delegate.js --backend fake wait --all --group demo --timeout-sec 60 --json
```

## Definition of done

Full suite green, stdout byte-exactness asserted, and every documented example carries a budget.

## Commit message

```
feat: core job commands with byte-exact stdout and a stable JSON envelope
```

## Notes
