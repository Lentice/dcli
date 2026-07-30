# 62 — Codex result read is unbounded; missing result file is silently reported as a clean empty result

**What to build:** the codex adapter's `CollectResult` reads the `-o result.txt` file with a finite byte cap (seek-then-read, not `readFileSync` then slice) AND when the file is missing emits a `backend_error` fact so the failure is classified — instead of returning `text: ''` and letting the engine record a clean `done` for a job whose result artifact was never written.

**Blocked by:** None — can start immediately (coordinate with ticket 57 — `Recover` is the upstream "what was the state" decision; ticket 62 is the `CollectResult` ingest.)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `adapters/codex/adapter.js` `CollectResult` (around line 549-555): the result file is read with a bounded seek-then-read flow:
  - `fs.statSync(path)` to get size
  - if size > `MAX_RESULT_BYTES` (a new constant, e.g. 1 MB), `fs.openSync` then `fs.read(fd, buf, 0, MAX, position)` — do NOT load the entire file then slice (the documented "bounded tail that calls readAllBytes and then slices is not bounded" trap, `AGENTS.md` §3).
  - if the file is within budget, `readFileSync` is fine for simplicity, provided the size check ran first.
- [ ] When the file is missing (`ENOENT`), `CollectResult` does NOT silently return `text: ''`. It either: (a) emits a `backend_error { class_hint: 'execution_error', detail: { reason: 'result_file_missing' } }` fact AND returns `text: ''` with a flag indicating "no usable result", so the engine's `Recover`/reducer (ticket 57 + 55) can decide `failed`; or (b) returns a `backend_error`-shaped collected result that the engine treats as failure. Pick (a) — it preserves the fact→state contract (Invariant #2) and lets the reducer terminal-classify.
- [ ] The "empty but present" result file (`size === 0`) keeps today's `text: ''` behaviour — that's a legitimate "codex produced an empty message", classified separately from "file missing" (`AGENTS.md` minor-rules §6: "A 0-byte result is empty, not a crash — classify it, don't throw").
- [ ] Test: missing result file → attempt reaches `failed` (or at least non-`done`) via the emitted `backend_error` fact, with `failure_reason: 'result_file_missing'` or equivalent.
- [ ] Test: large result file (e.g. 5 MB) → exactly `MAX_RESULT_BYTES` bytes returned (or the full file if < cap), with a `truncated: true` flag on the collected result, NOT a memory blow-up.
- [ ] Test: empty-but-present result file → `text: ''` returned, attempt can still reach `done`.
- [ ] Full suite green.

## Development guidance

- The "missing = clean empty" anti-pattern is the project's most-expensive bug class (`AGENTS.md` §7, "A parse failure must never read as a clean result"). This ticket is the codex-side instance of it.
- `core/result-artifact.js` knows about `findings_status: ok|absent|malformed`; an adjacent flag for the result text — `result_status: ok|empty|missing|oversize` — would make the contract explicit. If you add it, do so append-only (Invariant #4 — never rename or repurpose the existing fields). Recommend adding it as a new field on the collected-result object, surfaced through the envelope.
- The opencode adapter likely has a similar unbounded-result issue (it accumulates stdout to `MAX_STDOUT_BYTES = 10MB` — already bounded, but the size limit is generous and may exceed the contract's user-facing cap). Verify and file a separate ticket if so; don't bundle.
- For the bounded read: the `core/bounded-tail.js` helper exists for stdout tailing. Borrow the seek-then-read shape but don't reuse it as-is (it's structured for tail, not head); write a small `boundedReadFromStart(path, maxBytes)` in `core/fs-text.js` shared by any adapter that needs it.
- `claude` adapter already buffers stdout to a cap — verify and confirm it doesn't have the same missing-file bug (probably not — claude returns text from in-memory stdout, not a file). Note it in the commit if you confirm.

## Why it matters

A codex job that crashed mid-execution before writing `-o` reads as a clean empty done — and the agent reading `read` thinks the assistant just returned an empty response. The user trusts a garbage result. The fix is to say what's wrong: the file is missing, that's a failure class, record it as such.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

## Commit message

```
fix(codex): bound result read and classify missing result file as backend_error, not clean empty
```