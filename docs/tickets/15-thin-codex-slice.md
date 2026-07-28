# 15 — Thin codex adapter slice

**Blocked by:** 02, 10
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), [reference/cli-codex.md](../reference/cli-codex.md),
`AGENTS.md` "Smaller rules".

**Build this in parallel with ticket 14.** They are two halves of one proof, and this is the half that
matters most.

---

## Purpose

`dcli-codex run "say hello"` works against a real Codex install, through the narrowest possible adapter.

## Why it matters — this is the whole point of the ticket

Codex is the **counterexample the contract must survive**. It is a single-shot stdio child process:

- no server
- no session API and no queryable status
- no graceful cancel — exactly **one** cancellation rung
- no way to answer a permission prompt at all

Two independent reviewers identified that building the engine against opencode alone would over-fit the
adapter contract to HTTP sessions, after which Codex would need *fake* sessions or the engine would grow a
parallel synchronous path. This ticket is the check that catches that while it is still cheap to fix.

**If satisfying this ticket requires a backend conditional in `core/`, or an invented session concept in the
adapter, stop. The contract is wrong — fix the contract, not this adapter.**

## Facts you need (verified, codex-cli 0.145.0)

- `codex exec [PROMPT]` — prompt positional, or **read from stdin** when omitted or when `-` is given. If
  stdin is piped *and* a prompt is given, stdin is appended as a `<stdin>` block.
- `--json` prints events to stdout as **JSONL**.
- `-o, --output-last-message <FILE>` writes the agent's last message to a file. This is the reliable result
  path — prefer it over reconstructing text from the event stream.
- `-s, --sandbox read-only | workspace-write | danger-full-access`.
- `-a, --ask-for-approval never` — execution failures return to the model instead of prompting.
- `-C, --cd <DIR>` sets the working root.
- **There is no `--effort` flag.** Effort is `-c model_reasoning_effort=<level>` as a single `-c` pair.
  Observed enum: `none|minimal|low|medium|high|xhigh|max|ultra` — re-derive on every upgrade.
- `--ignore-user-config --ignore-rules --ephemeral` gives a clean, reproducible, non-persisting run.
- On Windows, npm installs both `codex.cmd` and `codex.ps1`.

## Design

1. `cli/dcli-codex.js` selects the backend before argument parsing.
2. `adapters/codex/adapter.js`:
   - `Start`: spawn under containment (ticket 06) with argv built as an **array**:
     `codex exec --json --color never -s <sandbox> -a never -C <dir> -o <result-file> -`
     then write the prompt to stdin — **with output readers already armed** (ticket 07).
   - Map Codex JSONL onto closed-set facts. Emit `process_exited` on exit.
   - `CollectResult`: read the `--output-last-message` file. A **0-byte file is "empty", not a crash** — that
     was a real bug; classify it so the engine can return exit `11`.
   - `DeclareCancelRungs()` → **`['hard_kill']`**, and nothing else.
3. Terminality comes from the engine reducer using `process_exited` + a validated result + a completed
   drain. **The adapter invents no session concept and no idle status.**
4. Executable resolution: resolve to the **executable** form, not the `.ps1`. If the resolved binary is a
   `.cmd`, apply the two-layered quoting rule (Win32 quoting **plus** force-quoting of cmd metacharacters
   `& | < > ( ) ^ %`, assigned as one pre-quoted string so the runtime does not re-escape it) — and share
   that builder with the detach path. **One implementation, not two.**
5. Argument order matters: exec-level options must precede any subcommand token. The predecessor shipped a
   fix for getting this wrong. Golden-test the argv.

## Pitfalls

- Do not reconstruct the final message from the event stream when `--output-last-message` exists.
- Do not emit `backend_status` — Codex has none. An adapter that fabricates one corrupts the contract.
- Do not implement `Respond`. Codex cannot answer a prompt; the capability must declare that honestly.
- Never write the prompt to stdin before arming the readers (~100 KB prompts deadlock).
- Effort is not a flag. Do not add `--effort` to the Codex argv.

## Checklist

- [ ] `dcli-codex` shim selects the backend before argument parsing.
- [ ] Adapter runs `codex exec --json` with the prompt on **stdin** and `-o` for the result.
- [ ] argv is built as an **array** and golden-tested, with exec-level options before any subcommand token.
- [ ] `.cmd` shims are spawned as `%ComSpec% /d /s /c <pre-quoted line>`; a test asserts a direct
      `spawn("*.cmd")` is never attempted, because Node rejects it with **`EINVAL`** (verified on Node v24.18.0).
- [ ] Every spawn passes `windowsHide: true`; no descendant owns a visible window.- [ ] The executable resolves to the executable form; a test uses an **npm-shaped PATH** with both shims present.
- [ ] If the resolved binary is a `.cmd`, the two-layered quoting rule is applied and **shared** with the
      detach path; a test asserts one implementation.
- [ ] Output readers are armed before the stdin write; a ~100 KB prompt does not deadlock.
- [ ] Codex JSONL maps onto closed-set facts only; unknown event types are logged, never fatal.
- [ ] A 0-byte result file is classified as empty (engine returns exit `11`), not a crash.
- [ ] `DeclareCancelRungs()` returns exactly `['hard_kill']`, and cancellation works with that single rung.
- [ ] The adapter emits no `backend_status` and implements no `Respond`; capabilities declare both as absent.
- [ ] Terminality is decided by the engine reducer, not the adapter.
- [ ] **The same contract test suite passes against this adapter, unmodified.**
- [ ] **A test asserts `core/` contains no backend-specific conditional.**
- [ ] Version is detected and gated; effort maps to `-c model_reasoning_effort=<level>`.
- [ ] A live smoke test exists, opt-in, skipped with a clear message when Codex is absent.

## How to verify

```powershell
node tests/run-tests.js --suite full
node cli/dcli-codex.js run --hard-timeout-sec 300 "Reply with exactly: PONG"
```

Then the design check that justifies this ticket: **diff the two adapters' shapes.** If the opencode adapter
needed contract features this one cannot use at all — or vice versa — write that down in Notes. That
asymmetry is expected for *capabilities*; it is a problem for *required operations*.

## Definition of done

The unmodified contract suite passes against both this adapter and the opencode adapter, and the
no-backend-conditional test passes.

## Commit message

```
feat(codex): thin adapter slice proving the contract against a single-shot CLI backend
```

## Notes

Record the two-adapter shape comparison here.
