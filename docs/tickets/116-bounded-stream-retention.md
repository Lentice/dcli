# 116 — codex and claude stream collectors grow without a bound

**Status:** ready
**Blocked by:** —
**Tier:** A noisy backend (or a single unbroken line) can grow the retained stdout/stderr to
unbounded size until the job hard timeout — the exact memory-exhaustion shape the §13 line-size
rule and the opencode adapter's caps exist to prevent.
**Filed from:** 2026-08-11 dual-backend audit (codex F-8)

---

## Symptom / Goal

- `adapters/codex/adapter.js` — `_stdoutContent` (`:185`), `_stderrContent` (`:186`),
  `_lineBuffer` (`:189`) are appended without a cap (`:352-353, :367`).
- `adapters/claude/adapter.js` — same shape: `_stdoutContent` (`:88`), `_stderrContent` (`:89`),
  `_lineBuffer` (`:92`), appended at `:249-250, :264`; the retained complete stream is later
  split for result extraction (`:368-369`).

The opencode adapter already has explicit caps (`adapters/opencode/server.js:53-54, 368-375`).
`docs/design-spec.md` §13 says: "Bound maximum line size." — the codex/claude adapters do not
bound it.

## Root cause

The codex and claude adapters retain full diagnostic streams and partial-line buffers with no
size bound, while their sibling adapter caps them. The retained streams exist for diagnostics and
(claude) result extraction; the fix must cap without losing parse correctness or the result tail.

## Binding constraints — quoted, do not go looking for them

`docs/design-spec.md` §13, rules: "Bound maximum line size. Log malformed JSON lines; never make
them fatal."

`docs/design-spec.md` §5: "When an attempt collects a result, it writes `result.md` before its
terminal status projection." — result extraction must keep working; a cap that truncates the
result text is a regression.

## Files to read and trace first

- `adapters/opencode/server.js:45-60, 360-380` — the existing caps to mirror (values and
  truncation-marker style).
- `adapters/codex/adapter.js:180-200, 345-375, 415-430, 490-505` — the collectors, the JSONL
  event parsing (a truncated line mid-JSONL is a parse error — the cap must never split a line
  the parser will read), and the separate result-file cap (`:13, :493-500`).
- `adapters/claude/adapter.js:85-95, 240-270, 310-325, 360-380` — same, plus `:368-369` where
  the retained stream is split for result extraction.
- `tests/adapters/codex/` and `tests/adapters/claude/` — existing stream/parse tests to extend.

## What to build

1. **Bound the three collectors per adapter** (codex and claude): a total-byte cap on
   `_stdoutContent`/`_stderrContent` and a separate cap on `_lineBuffer` (a partial line can be
   one unbroken multi-megabyte line). Use the opencode caps as the value reference (or the
   same order of magnitude; state the chosen values in the ticket Notes). Keep semantics:
   - **Tail, not head.** When a cap is exceeded, drop the oldest bytes and keep the newest (the
     result text is at the end of the stream; diagnostics benefit from the most recent output).
   - **Line-safe.** `_lineBuffer` holds a partial JSONL line; a cap must keep the line intact for
     parsing — the practical rule: cap the *complete* lines retained in `_stdoutContent` (drop
     oldest whole lines) and hard-cap `_lineBuffer` itself only at a bound far above any real
     event (documented), because truncating a partial line corrupts the parser.
   - **Truncation marker.** When bytes are dropped, note it (e.g. a `… <truncated N bytes>` prefix
     marker in the retained content, or a diagnostic flag consumed like the opencode adapter's)
     so diagnostics do not silently present a partial stream as complete.
2. **Verify claude's result extraction survives the cap.** `:368-369` splits `_stdoutContent`;
   with a tail-keep cap the final result section survives; add a test with a large stdout
   preamble followed by the result text asserting the extracted result is intact.
3. **Tests.** For both adapters: feed a stream larger than the cap through the existing fake
   child harness; assert retained content is bounded, the truncation marker is present, and
   JSONL events that completed before the cap still parse.

## Non-goals

- **No change to the result-file path** (codex's separate capped result file stays as is).
- **No change to opencode's existing caps.**
- **No change to what the reducer sees** — this bounds memory only; event/result semantics are
  preserved for every event that was parsed before truncation.

## Acceptance criteria

- [ ] **A.** For codex and claude, a >cap stream leaves all three collectors bounded; a
  truncation marker is present when bytes were dropped.
- [ ] **B.** No JSONL event that began before the cap is corrupted; parse of retained complete
  lines is unchanged.
- [ ] **C.** Claude's result extraction still returns the full result text when stdout contains a
  large preamble.
- [ ] **Z.** `npm run check` green; the tracker table regenerated.

## Agent checks

```bash
# What this proves: every collector in both adapters is bounded.
rg -n "\+= chunk" adapters/codex/adapter.js adapters/claude/adapter.js
# expect: every append site is preceded by a cap check (or the cap lives in one helper both use)

# What this proves: a marker exists when truncation happens.
rg -n "truncat" adapters/codex/adapter.js adapters/claude/adapter.js
# expect: the marker site(s)

npm test -- --grep "stream"   # expect: green, including the oversized-stream cases
```

## Notes

(Left empty by the author. The implementer fills it in: what was changed and where, build and suite
results, the Agent checks' actual output, any deviation from this ticket and why, and anything
discovered that contradicts the docs.)
