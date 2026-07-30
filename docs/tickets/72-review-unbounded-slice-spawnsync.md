# 72 — `review` reads untracked files unbounded into memory; char-slices a byte budget; git diff `maxBuffer` overflow silently produces an empty diff; `spawnSync` git calls have no timeout

**What to build:** `core/commands/review.js` stops reading entire untracked files into memory before checking size; slicing for byte budgets uses real byte lengths (not character counts); git diff `spawnSync` failures surface as `no_diff`/`diff_failed` rather than silently becoming an empty-diff review; every git `spawnSync` is bounded.

**Blocked by:** None — can start immediately (coordinate with ticket 7 which created the bounded-tail helper; this is the review-side cousin)

**Status:** ready-for-agent

## Acceptance criteria

### A. Unbounded untracked-file read (memory DoS)
- [ ] `core/commands/review.js` (around line 161): untracked file content is `fs.statSync` → bounded `fs.read(fd, buf, 0, UNTRACKED_SIZE_LIMIT, 0)` — NOT `fs.readFileSync(filePath, 'utf8')` BEFORE the size check. A multi-GB untracked file cannot OOM the wrapper.
- [ ] A `truncated: true` flag is set in the review detail when the size cap kicks in, alongside the existing `untracked_warning` envelope field.

### B. Char-vs-byte slicing
- [ ] `core/commands/review.js` (around line 96-99 for diff; around line 165 for untracked): all `.slice(0, N)` operations on text content use `Buffer.byteLength(str, 'utf8')` semantics — buffer-cut then toString, or replace with a `sliceByBytes(str, maxBytes)` helper in `core/fs-text.js`. The marker text claims "truncated at <bytes>" — the slice must enforce bytes.
- [ ] Test: a review with multibyte UTF-8 content (e.g. diff content with CJK characters) where the byte size exceeds `DIFF_CAP_BYTES` produces a `diff_bytes` reporting the ACTUAL byte count, AND the diff text passed to the adapter does not exceed `DIFF_CAP_BYTES` bytes when re-encoded. Today the `.slice(0, DIFF_CAP_BYTES)` slices characters, so multi-byte content over-runs the byte cap.

### C. git diff `maxBuffer` overflow silent
- [ ] `core/commands/review.js` (around line 84-100): after `spawnSync('git', gitArgs, { maxBuffer: ... })`, the code checks `result.error` (synchronous ENOENT/EACCES) and `result.status` (non-zero git exit). On overflow (`result.error && result.error.code === 'ENOERR'` with `stdout` containing a partial buffer or truncated) — `result.error` will be `RangeError: stdout maxBuffer length exceeded` — the review now reports `diff_failed: 'maxbuffer'` to the adapter (or `no_diff` if it really was empty) INSTEAD of silently proceeding with an empty diff.
- [ ] Add `findings_status: 'absent'`/`'malformed'` style surface — `diff_status: 'ok' | 'absent' | 'failed'` — witnessing explicit failure. (Append-only: new field, not reusing existing.)
- [ ] Test: simulate a diff overflowing `maxBuffer` (e.g. set `maxBuffer` tiny and diff a large file) — `diff_status` is `'failed'` and the review detail explains why; the adapter is NOT given an empty diff and told "go review it."

### D. spawnSync git timeout
- [ ] `core/commands/review.js` `spawnSync` calls (around line 84-89 git diff, and around line 139 git ls-files) pass `timeout: <bounded>` — `resolveDeadline('GIT_SPAWN_TIMEOUT_MS')` or a new declared constant (e.g. 30000). Today no `spawnSync` timeout exists; a `git` wedged on a held index lock blocks the entire CLI indefinitely.
- [ ] Compare the existing pattern in `core/state-root.js` and `core/worktree.js` which DO pass timeouts — copy the shape.

### E. Other
- [ ] Full suite green.

## Development guidance

- A shared `sliceByBytes(str, maxBytes, encoding='utf8')` helper in `core/fs-text.js` serves this and likely other callers; pull the bounded-tail helper as inspiration but don't reuse it (that's tail; this is head). Write a small new helper.
- The `core/bounded-tail.js` helper has an existing char-vs-byte bug (its `lines[i].length > maxBytes*2` comparison compares chars to bytes) — that's a related ticket-able but NOT this ticket; note it in the commit body and file a follow-up if you find it cleanly separable.
- For the `maxBuffer` overflow: spawnSync raises `RangeError` as `result.error` (`result.error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` in modern Node, but historically a plain RangeError — check both). Render this as `diff_status: 'failed'`, never an empty diff.
- For the timeout: `spawnSync` with `timeout` and `killSignal: 'SIGTERM'` — git handles SIGTERM cleanup.
- Do NOT lose coverage on the "genuinely empty diff → clean review" path; it must remain valid. `diff_status` distinguishes "absent" (no changes to review — the only clean-empty case) from "failed" (a git error masquerading as empty).

## Why it matters

This is `AGENTS.md` §7 ("Silent truncation" + "parse failure read as a clean result") in `review` — the very path that's supposed to surface defects. A large diff silently becomes an empty review (the reviewer says "no issues"); a multi-GB untracked file OOMs the wrapper; a wedged git hangs the CLI forever. The predecessor's history calls this out explicitly.

## How to verify

```powershell
node tests/run-tests.js --suite full
```

## Commit message

```
fix(review): bounded untracked read, byte-true slicing, surfaced git failures, bounded git calls
```