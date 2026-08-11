/**
 * Bounded retention for backend diagnostic streams (ticket 116).
 *
 * The codex and claude adapters retain stdout/stderr text and a partial-line
 * buffer for diagnostics and result extraction. Without a cap, a noisy
 * backend (or a single unbroken line) grows them without bound until the job
 * hard timeout — the exact memory-exhaustion shape the opencode adapter's
 * caps (adapters/opencode/server.js) exist to prevent.
 *
 * Cap values: 10 MiB per retained stream (mirrors opencode's MAX_STDOUT_BYTES
 * / MAX_STDERR_BYTES), and a separate 2 MiB hard cap on the partial-line
 * buffer — far above any real JSONL event line, so normal lines are never
 * touched, while a pathological single line degrades to a parse error
 * (non-fatal by contract) instead of unbounded memory.
 *
 * Semantics:
 * - Tail, not head: when a cap is exceeded the oldest bytes are dropped and
 *   the newest kept, because the result text is at the end of the stream and
 *   diagnostics benefit from the most recent output.
 * - Line-safe: eviction drops whole lines only, so the retained region always
 *   starts on a line boundary and no complete line is ever split by the cap.
 *   The partial-line buffer is capped separately (see capPartialLine).
 * - Truncation marker: when bytes are dropped, a `… <truncated N bytes>` line
 *   is placed at the front of the retained content so diagnostics are never
 *   silently presented as a complete stream.
 */

const MAX_RETAINED_STREAM_BYTES = 10 * 1024 * 1024;
const MAX_PARTIAL_LINE_BYTES = 2 * 1024 * 1024;
const TRUNCATION_PREFIX = '… <truncated ';

/**
 * @param {number} droppedBytes
 * @returns {string}
 */
function truncationMarker(droppedBytes) {
  return `${TRUNCATION_PREFIX}${droppedBytes} bytes>\n`;
}

/**
 * Keep only the newest `capBytes` of `combined`, extending the cut to the
 * next newline so the retained region starts on a whole-line boundary (a
 * line the cut lands on is dropped whole). A region with no newline is an
 * unbroken single line; it cannot be kept whole, so its newest `capBytes`
 * are kept as-is (that line is unparseable either way).
 *
 * @param {string} combined
 * @param {number} capBytes
 * @returns {{ content: string, dropped: number }}
 */
function lineSafeTail(combined, capBytes) {
  if (combined.length <= capBytes) return { content: combined, dropped: 0 };
  const cut = combined.length - capBytes;
  const nl = combined.indexOf('\n', cut);
  const kept = (nl !== -1 && nl + 1 < combined.length)
    ? combined.slice(nl + 1)
    : combined.slice(cut);
  return { content: kept, dropped: combined.length - kept.length };
}

/**
 * Append `chunk` to retained stream `content`, keeping the newest bytes
 * within `capBytes`. A single chunk larger than the cap keeps only its own
 * tail. Returns the new content and the number of bytes dropped.
 *
 * @param {string} content
 * @param {string} chunk
 * @param {number} capBytes
 * @returns {{ content: string, dropped: number }}
 */
function appendRetained(content, chunk, capBytes) {
  let dropped = 0;
  if (chunk.length > capBytes) {
    dropped += chunk.length - capBytes;
    chunk = chunk.slice(chunk.length - capBytes);
  }
  const applied = lineSafeTail(content + chunk, capBytes);
  return { content: applied.content, dropped: dropped + applied.dropped };
}

/**
 * Prepend the truncation marker to retained content, evicting the oldest
 * content bytes (whole lines) so marker + content stays within the cap.
 * Callers re-insert the marker whenever bytes were dropped and it is not
 * already present: the line-safe eviction in appendRetained may evict the
 * marker itself, which is the signal that the count changed.
 *
 * @param {string} content
 * @param {number} capBytes
 * @param {number} droppedBytes
 * @returns {string}
 */
function withTruncationMarker(content, capBytes, droppedBytes) {
  const marker = truncationMarker(droppedBytes);
  return marker + lineSafeTail(content, capBytes - marker.length).content;
}

/**
 * Append `chunk` to the partial-line buffer with a hard cap. Truncating a
 * partial line corrupts it for parsing, so this cap sits far above any real
 * event line; a pathological line that exceeds it degrades to a parse error,
 * which is non-fatal by contract.
 *
 * @param {string} buffer
 * @param {string} chunk
 * @param {number} [capBytes]
 * @returns {string}
 */
function capPartialLine(buffer, chunk, capBytes = MAX_PARTIAL_LINE_BYTES) {
  buffer += chunk;
  if (buffer.length > capBytes) {
    buffer = buffer.slice(buffer.length - capBytes);
  }
  return buffer;
}

module.exports = {
  MAX_RETAINED_STREAM_BYTES,
  MAX_PARTIAL_LINE_BYTES,
  TRUNCATION_PREFIX,
  truncationMarker,
  lineSafeTail,
  appendRetained,
  withTruncationMarker,
  capPartialLine,
};
