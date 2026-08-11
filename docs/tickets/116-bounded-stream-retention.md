# 116 — codex and claude stream collectors grow without a bound

**Status:** done
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

Implemented by the ticket's TDD order (red → green → full suite → agent checks → commit).

**What and where.** New shared helper `adapters/shared/stream-retention.js` holds the caps and all
cap logic, used by both adapters (the ticket's sanctioned "cap lives in one helper both use" shape):

- `MAX_RETAINED_STREAM_BYTES = 10 MiB` (mirrors opencode's `MAX_STDOUT_BYTES`/`MAX_STDERR_BYTES`),
  applied to `_stdoutContent` and `_stderrContent` in both adapters.
- `MAX_PARTIAL_LINE_BYTES = 2 MiB` — the hard cap on `_lineBuffer`, far above any real JSONL event
  line; a pathological line degrades to a parse error (non-fatal by contract).
- `appendRetained()` — tail-keep append, whole-line eviction only (`lineSafeTail()`), so the cap
  never splits a line the parser reads and the retained region always starts on a line boundary.
- `withTruncationMarker()` / `TRUNCATION_PREFIX` — a `… <truncated N bytes>` line is stamped at the
  front of the retained content when bytes are dropped (N = cumulative dropped at insertion). The
  marker itself is a line within the cap; later eviction may drop it, and it is re-stamped with an
  updated count on the next dropping append.
- `capPartialLine()` — hard caps `_lineBuffer` after each chunk, keeping the tail of an unbroken
  oversized line.

Adapters: codex `adapters/codex/adapter.js` and claude `adapters/claude/adapter.js` each gained
`_appendStdout`/`_appendStderr` (data handlers now route every append through them) and track
`_stdoutTruncatedBytes`/`_stderrTruncatedBytes` for diagnostics. The JSONL framing path is
otherwise untouched: parsing still runs off `_lineBuffer`, so events completed before the cap are
parsed exactly as before, and `_collectResultFromEvents` (`:368-369` split) tolerates the marker
line and any line the cap cut via its existing per-line try/catch. Result-file cap (codex
`MAX_RESULT_BYTES`) and opencode's caps unchanged (non-goals).

**Chosen values.** 10 MiB per stream / 2 MiB partial line — documented in the helper's header.

**Tests.** New `tests/adapters/stream-retention.test.js` (`// @suite full`, spec-loop over both
adapters via the `ScriptedChild` harness, asserting against the imported real caps): (1) >cap
stdout+stderr leaves all three collectors bounded with the marker present and pre-cap events
parsed intact (criteria A+B); (2) an unbroken >cap line leaves `_lineBuffer` bounded; (3) claude's
`CollectResult` returns the full result text, `result_status: 'present'`, usage and session id
after a >cap preamble (criterion C).

**Suite results.** `npm run check` green: lint clean; full suite 34 adapters + 2 contract + 62 core
+ 1 helpers + 3 integration passed, exit 0. Two intermediate full-suite runs hit pre-existing
load-sensitive flakes in unrelated `core/` files (`test-runner.test.js` 100% vs 101% budget
rounding; `job-store.test.js` lingering `status.json.tmp-*` under parallel load) — both pass in
isolation and on the final clean run; neither touches this change.

**Agent checks.**
- `rg -n "\+= chunk"` over both adapters → no matches: every append now flows through the shared
  helper (the ticket's sanctioned alternative to per-site cap checks).
- `rg -n "truncat"` over both adapters → the `_appendStdout`/`_appendStderr` marker sites plus the
  pre-existing codex result-file truncation logic.
- The ticket's `npm test -- --grep "stream"` cannot run literally: the runner has no `--grep` flag.
  Ran `node tests/adapters/stream-retention.test.js` directly (green) and the full suite.

**Deviations.** None. Marker byte count is cumulative dropped at the marker's last (re-)insertion,
so it can undercount by the bytes the marker itself displaced — informational only, never parsed.
