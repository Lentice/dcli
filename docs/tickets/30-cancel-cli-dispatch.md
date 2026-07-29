# 30 — Wire `cancel` into the CLI dispatcher

**Blocked by:** 29 (cancelling a job requires a job that can actually be running in the background)
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` "The nine mistakes" #4
(process trees do not die the way you expect), ticket 08 (declared rungs).

---

## Purpose

`dcli-<backend> cancel <job-id>` must actually cancel a running job. Today the command does not exist in
the CLI dispatcher at all.

## Why it matters

Help text lists `cancel`, and every adapter's `capabilities_snapshot.core.cancel` is advertised as `true`.
An agent following the generated skill docs (which teach "use cancel for a stuck job") will type a command
that falls through as unknown. **A stuck background job cannot be stopped through the tool that is
supposed to manage it** — the exact failure mode `AGENTS.md`'s eight-hour-stall story is about, except now
even the escape hatch is missing.

## Evidence (verified)

`cli/dcli.js`'s command switch has cases for `run, submit, status, wait, read, resume, list, review, tail,
debug, cleanup, capabilities, diff, apply, doctor` — **no `case 'cancel'`**, even though line 14 lists it
in `help` and line 591 declares `cancel: true` in the fake adapter's capability manifest.

## Design

- Add a `case 'cancel':` that:
  - Requires a job ID positional; reject with exit 2 if missing.
  - Reads the job's current status and attempt/containment identity.
  - Calls into `core/cancel.js`'s existing `cancelJob`-style logic (built in ticket 08) with the
    documented declared rungs, escalating through them with bounded waits per rung.
  - Returns **exit code 21** when termination could not be confirmed (per the design spec's exit-code
    table) rather than silently reporting success.
  - Supports `--json` envelope output consistent with every other command.
- If a job has no live worker (already terminal, or `submit`'s worker was never actually launched before
  ticket 29 lands), cancel must report that plainly rather than hang or crash.

## Pitfalls

- Do not advertise `cancel: true` in any adapter's capability manifest for a backend whose end-to-end
  cancel path is not tested — if a backend genuinely cannot support graceful cancel yet, the manifest
  should say so honestly (per `AGENTS.md`'s capability-manifest doc-check invariant).
- Do not kill by image name or bare pid — identity must be pid + creation time + image path + execution
  token, per mistake #4.

## Checklist

- [ ] `cancel <job-id>` is a real case in `cli/dcli.js`'s dispatcher.
- [ ] Cancel escalates through declared rungs with bounded waits, re-snapshotting the process tree between
      steps, innermost-first.
- [ ] Exit code 21 is returned when termination is unconfirmed; 0 (or the documented success code) when
      confirmed.
- [ ] A regression test drives `cancel` against a fixture that resists graceful shutdown and asserts the
      job ends up terminated or reported as unconfirmed — never left silently "cancelled" while a process
      tree survives.
- [ ] `--json` output for `cancel` matches the same envelope shape as other commands.

## How to verify

```powershell
node tests/run-tests.js --suite full
node cli/dcli-codex.js submit --repo . --prompt-file <file> --hard-timeout-sec 600 --json
node cli/dcli-codex.js cancel --repo . <job-id> --json
node cli/dcli-codex.js status --repo . <job-id> --json   # must show cancelled/interrupted, not running
```

## Definition of done

Full suite green; a live background job can be cancelled through the primary CLI and its terminal state
correctly reflects the outcome.

## Commit message

```
fix: wire cancel into the CLI dispatcher with bounded rung escalation
```
