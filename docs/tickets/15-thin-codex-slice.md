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

### Two-adapter shape comparison

| Aspect | opencode adapter | codex adapter |
|---|---|---|
| `DeclareCancelRungs()` | 3 rungs: `session_abort`, `server_dispose`, `hard_kill` | 1 rung: `['hard_kill']` |
| `ProbeCapabilities().extensions` | Declares `graceful_session_abort`, marks perms/questions as unsupported | Empty `{}` — no extensions |
| `ValidateRequest()` | Accepts `variant`; rejects `reasoningEffort`, `effort` | Accepts `effort`, `reasoningEffort`; rejects `variant` |
| `Start()` | Starts `opencode serve` HTTP server, waits for port | Spawns `codex exec --json` as single-shot child |
| `SendPrompt()` | HTTP POST `/session` + `/session/{id}/message` | Writes prompt to stdin, closes stdin |
| `Observe()` | Yields pre-constructed in-memory facts | Parses JSONL events from stdout into facts |
| `CollectResult()` | Reads last `assistant_text` fact from memory | Reads `--output-last-message` file from disk |
| `RequestCancel()` | 3-rung ladder: HTTP abort → HTTP dispose → kill | One-shot: kill process tree |
| `Dispose()` | HTTP dispose + kill server process | Kill child + clean temp dir |
| `backend_status` fact | Never emitted (has no queryable status) | Never emitted (has no queryable status) |
| `Respond()` | Throws (not supported) | Throws (not supported) |

**Design verdict:** The contract successfully accommodates both adapter shapes without any backend-specific conditional in `core/`. The opencode adapter is session-based (HTTP server per job, queryable status), while the codex adapter is a single-shot child process (no queryable status, no graceful cancel). Both cleanly map onto the same contract interface. The asymmetry is exactly where ADR-004 says it should be: in capabilities and extensions, not in required operations.

### Findings from implementation

- `PrepareInvocation()` is not called by `executeRun()` or `executeSubmit()` — the engine does not yet invoke it, so the adapter stores the request during `ValidateRequest()` instead.
- Full suite times out because opencode adapter tests attempt to spawn real opencode server processes; this is pre-existing and not introduced by this ticket.

### Correction: the live path did NOT work end-to-end as first claimed — four real bugs found and fixed

The original commit's claim that the live-smoke test "verified the version-detection and
executable-resolution paths work end-to-end" was **not actually true**. Manually running the
ticket's own verification command —
`node cli/dcli-codex.js run --hard-timeout-sec 60 "Reply with exactly: PONG"` — produced
**exit 0 with completely empty stdout/stderr**, exactly like ticket 14's original bug but with a
different root cause. All four of the following were confirmed and fixed on this machine:

1. **`resolveCodexPath()` picked the unusable bare wrapper.** `where codex` on this npm-global
   install returns the extensionless JS shebang script first, then `codex.cmd`. The function only
   filtered out `.ps1`, so it returned the bare file — which Node's `spawn()` cannot execute
   without a shell (no interpreter line handling on Windows `CreateProcess`). Fixed by resolving
   past the wrapper to the real per-platform vendor binary
   (`@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`, nested inside the
   `codex` package's own `node_modules`, not a top-level sibling — the search had to walk into
   that nested shape specifically), falling back to preferring `.cmd` over the bare file if no
   vendor binary is found. Also had to explicitly skip a stale npm atomic-install temp directory
   (`.codex-<random>`, dot-prefixed, holding an older 0.144.6 build) that the search initially
   matched by accident.
2. **`buildArgv()` passed `-a never`, a flag that does not exist.** Verified against the real
   installed codex-cli 0.145.0's `codex exec --help`: there is no approval-prompt flag at all —
   `exec` is already non-interactive by design, governed solely by `-s <sandbox mode>`. Every real
   invocation failed with `error: unexpected argument '-a' found`, silently swallowed by the
   `child.on('error', ...)` handler as an unsurfaced fact. Removed the flag; updated
   `tests/adapters/codex/adapter.test.js`'s argv-shape test, which had asserted the flag's
   presence (i.e. it was testing the bug, not the contract).
3. **`Observe()` never actually waited for the real child to exit.** It was a single synchronous
   pass over whatever `_facts`/`_stdoutContent` happened to exist at the instant it was called —
   essentially immediately after `SendPrompt()` returns, long before the real process (which takes
   real wall-clock seconds) produces anything. Fixed with a genuine event-driven wait
   (`_waitForExit()`) resolved from the same `exit`/`error` handlers already registered in
   `Start()`. First attempt at this fix used a `setInterval(...).unref()` poll — also wrong: an
   unref'd timer doesn't keep Node's event loop alive, so the whole process exited silently before
   the promise ever resolved once nothing else was pending. Fixed to resolve directly from the
   exit event instead of polling.
4. **`cli/dcli.js`'s stdin-piped detection (shared code, not codex-specific) silently discarded a
   valid positional prompt.** `stdinPipeActive = !process.stdin.isTTY` treats *any* non-TTY stdin
   as "piped" — but `process.stdin.isTTY` is `undefined` in many legitimate non-interactive
   contexts that never pipe anything, including Claude Code's own tool-invoked shell (this
   project's primary real-world caller). The CLI would silently wait out the 5s bounded stdin
   read, get nothing, and use an empty prompt instead of the explicit positional argument. Fixed
   by only treating stdin as active when no positional or `--prompt-file` was also given — an
   explicit source should never be silently overridden by an ambiguous one. Note:
   `fs.fstatSync(0).isFIFO()` was tried as a more principled detection method first, but does not
   reliably report `true` even for a genuine `echo x | node ...` pipe under Git Bash on Windows —
   not usable on this platform.

All four confirmed fixed by re-running the manual verification command directly (not just via the
test suite, since every one of these bugs was invisible to `_testMode`-mocked tests): real
`PONG` now returns end-to-end, no orphaned `codex.exe` process survives, and the opt-in live-smoke
test (`tests/adapters/codex/live-smoke.test.js`) genuinely passes.
