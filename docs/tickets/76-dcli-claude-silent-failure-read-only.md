# 76 — `dcli-claude run` (default read-only) silently fails tasks needing the Task/subagent tool, with `failure_reason: null`

**What to build:** a `dcli-claude run` job that asks Claude to dispatch subagents or write files fails with an honest, observable signal — NOT a silent exit-1 with `failure_reason: null` and a one-line "I'll dispatch parallel agents" tail that leaves the operator unable to tell whether the backend is broken or the access mode was wrong. The cheapest fix: (1) make the backend error observable (`failure_reason` populated, failure message in the result) when Claude exits without producing a usable terminal state, and (2) surface a clear hint when `--access read-only` is suspect (a prompt mentioning "dispatch"/"subagent"/"write" is a strong signal), pointing at `--access workspace`.

**What was observed (verified against job state):**

- Job `20260730T061517Z-8r37lzcp` (`dcli-claude run` of a verification prompt that said "Read the cited files yourself — do NOT dispatch subagents"). `command.json`: `"access": "read-only"`, `"mode": "run"`, `"hardTimeoutMs": 1800000`. `status.json`: `state: failed`, `command_exit_code: 1`, `failure_reason: null`, `failure: null`, `result_bytes: 189`. `attempts/1/backend-events.jsonl`: `{"type":"started"...}` then `{"type":"process_exited","code":1}`. `result.md` had only: "This is a large verification task spanning 24 findings across many files. I'll dispatch parallel agents to verify batches, since each requires reading actual source and quoting exact lines." — Claude started to describe dispatching subagents, the subagent tool call (which needs `workspace` access) failed under `read-only`, and Claude exited 1 leaving the boilerplate as the only "result."
- A second identical attempt with (`--access workspace`) succeeded as far as Claude's own budget allowed, but that's a wallet-bounded stop mid-task, NOT the silent failure class this ticket targets.

**Blocked by:** None — can start immediately (coordinate with ticket 55 — the observe-end-flow that journals `failed`/`command_exit_code: 1` for an exit-1 backend is precisely where `failure_reason` should get written today but doesn't)

**Status:** done (2026-07-30) — failure_reason & failure now observable; access hint active

## Acceptance criteria

### A. Backend errors are observable on the `run` path
- [ ] `core/commands/run.js` observe-end path (around line 306-318) and the equivalent in `resume.js` (around 380-393) and `worker.js` (around 404-419): when the process exits non-zero with NO usable produced result (e.g. result text is empty or short and matches a "starting/apologizing" boilerplate-but-no-real-work shape), `failure_reason` is populated in the journal `detail` with a clear string (e.g. `'backend_exited_no_result'` for the generic case) AND `failure` carries an adapter-supplied or heuristic message if one is available. Today `failure_reason: null` and `failure: null` are journal'd even when Claude exited 1.
- [ ] Coordinate with ticket 55: ticket 55 routes the observe-end through the reducer. This ticket's contribution in that flow is to ensure the reducer/engine records the actual exit code AND the `backend_exited_no_result` reason on the journal `detail`.

### B. Cheap "needs more access" hint
- [ ] `cli/dcli.js` (or a small validator in `core/commands/index.js`): if `--access` is `read-only` (default or explicit) AND the prompt/pg prompt contains strong, near-zero-FP indicators of needing write access (a short allow-list of clearly-tool-dispatch phrasings: "dispatch subagent", "Task tool", "spawn agent", "write file", and similar) — print a **one-line stderr hint** as advice: `hint: --access read-only forbids subagent/write tools; --access workspace may be needed for this task`. Do NOT block the run; this is advisory.
- [ ] The hint is suppressible with `--quiet` / `--json` is unaffected (the envelope is the data channel; hints stay on stderr).
- [ ] This hint runs as a *fast* pre-dispatch check (no env knobs; do not ship as a hidden global).

### C. Tests
- [ ] Test: a fake adapter whose `Observe` yields `process_exited {code: 1}` and `CollectResult` returns empty text — `run` journals `failure_reason: 'backend_exited_no_result'` (or whatever concrete string is chosen) and the envelope's `failure_reason` is non-null, not `null`.
- [ ] Test: `dcli-claude run "please dispatch a subagent to..." ` (no `--access` flag → `read-only` default) prints the hint on stderr; `--json` envelope is unchanged; the run still proceeds (not blocked).
- [ ] Test: `dcli-claude run "ask the model a simple question"` does NOT print the hint (the heuristic does not flag plain questions).
- [ ] Full suite green.

## Development guidance

- The silent failure is the worst part — claude exited with a one-line "I'll dispatch parallel agents" tail; the operator cannot tell whether the backend is broken, the prompt is broken, or the access mode is wrong. The primary acceptance is A: make the failure observable. B is a nice-to-have; ship both if you can, ship A first if scope-tight.
- The boilerplate/short-result heuristic: be conservative — prefer a no-result (`result_bytes < N AND exitCode != 0`) criterion over a content match, to avoid false positives. Process exit non-zero + empty-ish result = backend-error-class, period.
- Do NOT change the default `--access read-only`. The default is correct (least privilege, AGENTS invariant: prefer least access). The advice hint is the cheap mitigation; forcing `workspace` by default would invert least-privilege.
- Coordinate with ticket 55 — the journal-failure event is the touch point. Don't bake the heuristic into `core/reducer.js`; the reducer is state-from-facts and shouldn't see exit code quirks. The reason-string construction lives in `run.js`/`worker.js` where the exit code is observed.
- Do NOT make `failure_reason` an opaque enum that callers can't grep — keep it a small stable set of human-readable strings: `'backend_exited_no_result'`, `'adapter_observe_error'`, `'hard_timeout'` (already exists), etc. Append-only (Invariant #4); don't repurpose existing values.

## Why it matters

The first attempt at verifying the ticket set (when the reviewer was about to publish to GitHub) produced a silently failed claude job with `failure_reason: null` and a misleadingly-terse `result.md`. The user, reading `dcli-claude status` for such a job, cannot tell that the failure was an access/tool-call limitation — they see `failed` with no reason, and the result body that "looked" like a normal first sentence. This is the `AGENTS.md` §6 ("A parse failure must never read as a clean result") AND §7 ("silent truncation") variant on the `run` path. The waste of an entire delegation attempt to silent failure is exactly the "unbounded wait cost a user eight hours" class, just in a faster-wrapping form.

## How to verify

```powershell
node tests/run-tests.js --suite full
# Live check: a prompt that mentions "dispatch subagent" with no --access flag prints
# the hint and still runs (doesn't block); a job that produces no usable result with
# exit 1 reveals a non-null failure_reason in `dcli-claude status`.
```

## Commit message

```
fix(run): backend-exited-no-result failures are observable, with a read-only-needs-workspace hint for tool-dispatch prompts
```