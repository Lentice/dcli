# 64 — `Observe` yields `process_exited` before `assistant_text`/`usage_reported` (non-temporal fact order in codex and claude)

**What to build:** the codex and claude adapters' `Observe` generators emit facts in the temporal order they occur on the wire — assistant message chunks, tool calls, usage reports, and `process_exited` last — instead of buffering everything to a string and parsing it after exit (today's flow, which yields `process_exited` first because it's the first fact in `_facts` after the synchronous `exit` event). This breaks `tail` (no live progress until the process is already gone) and contradicts the adapter contract §4.3 ("MUST yield facts in temporal order").

**Blocked by:** None — can start immediately (independent opencode path already streams live; this is codex+claude only)

**Status:** ready-for-agent

## Acceptance criteria

- [ ] `adapters/codex/adapter.js` `Observe` (around line 413-436): `assistant_text` chunks, `tool_invoked`, and `usage_reported` facts are yielded AS they parse from stdout, not buffered-then-flushed after exit. `process_exited` is yielded last (preserved).
- [ ] `adapters/claude/adapter.js` `Observe` (around line 299-316): same fix — yield stream-json events live.
- [ ] `tail` rich user sees incremental output as the backend works, instead of a sudden flush after exit. Add or extend a test asserting that for a multi-chunk assistant response, `Observe` yields ≥ 2 `assistant_text` facts interleaved with `process_exited` last.
- [ ] Ordering test: for an attempt with N assistant chunks then a process exit, `Observe` yields `[chunk1, chunk2, ..., chunkN, process_exited]`, never `[process_exited, chunk1, ...]`.
- [ ] Today's existing facts are preserved with the same `type` and payloads — only the order/yield-timing changes; no contract renames (Invariant #4).
- [ ] Full suite green.

## Development guidance

- The opencode adapter already does this correctly (SSE-driven, yields per-event as it arrives). Use its `Observe` as the model: register a stdout `'data'` listener that parses partial stream-json/NDJSON incrementally, buffers incomplete lines in a `lineBuffer`, and yields facts per completed line.
- For codex: codex `exec --json` emits newline-delimited JSON events. Parse each line on arrival; maintain `lineBuffer` for partial lines. On `exit`, drain any remaining `lineBuffer` (in case codex didn't emit a final newline), THEN yield `process_exited` (the exit handler sets a deferred-exit if the stream isn't drained, mirroring the read-before-write ordering `AGENTS.md` §2).
- For claude: claude `-p --output-format stream-json` emits JSON-per-event-delimited; same shape.
- The structural read-before-write and bounded-drain rules already exist (`core/deadlines.js`, `core/commands/index.js`). The drain-to-close behaviour after exit (`POST_EXIT_DRAIN_MS`) stays — just don't lock the `process_exited` fact to be the first emitted.
- The existing `_waitForExit` + `_waitForStreamDrain` ordering is fine; the fix is where the `yield` happens. Don't move `await this._waitForExit()` before the stream parse loop; rather, restructure so chunks yield live during the run.
- A helper `parseStreamJsonChunk(buffer)` shared by codex and claude would reduce duplication. Optional but recommended.

## Why it matters

`tail` is the live-debug command. Today it shows the assistant's full output only after the assistant is already gone — a "watch" that doesn't watch. The `process_exited`-first ordering also confuses any downstream consumer that assumes last-fact-wins; the reducer looks at fact sets as a whole so it's mostly tolerant, but tail and replay tools assume temporal order.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

## Commit message

```
fix(codex,claude): Observe yields facts in temporal order, not exit-first buffered
```