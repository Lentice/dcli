const fs = require('fs');

const TRUNCATION_MARKER = '\n... (truncated) ...\n';

/**
 * Read the tail of a file bounded by maxBytes.
 *
 * Seeks to `max(0, length - maxBytes)` and reads from there, avoiding
 * loading the entire file into memory. Truncates the first (oldest) line
 * if it is oversized, inserting a marker.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {{ content: string, truncated: boolean, totalBytes: number, returnedBytes: number }}
 */
function readTail(filePath, maxBytes) {
  if (maxBytes <= 0) {
    return { content: '', truncated: false, totalBytes: 0, returnedBytes: 0 };
  }

  const stat = fs.statSync(filePath);
  const totalBytes = stat.size;

  if (totalBytes === 0) {
    return { content: '', truncated: false, totalBytes: 0, returnedBytes: 0 };
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const seekPos = Math.max(0, totalBytes - maxBytes);
    const readLen = Math.min(maxBytes, totalBytes - seekPos);

    const buf = Buffer.allocUnsafe(readLen);
    const bytesRead = fs.readSync(fd, buf, 0, readLen, seekPos);
    const raw = buf.slice(0, bytesRead);

    let content = raw.toString('utf8');

    // If we seeked past the start, we might have a partial first line.
    // Truncate back to the first complete line and add a truncation marker.
    let truncated = seekPos > 0;
    if (truncated) {
      const firstNewline = content.indexOf('\n');
      if (firstNewline >= 0) {
        content = content.slice(firstNewline + 1);
      } else {
        // Entire content is one line that got split — still show it
        content = '';
      }
      content = TRUNCATION_MARKER.trimStart() + content;
    }

    // Check for oversized lines — if any single line exceeds maxBytes,
    // truncate it with a marker (this is about line-level truncation).
    // We already have a truncated indicator from seeking.
    // Additional line-level check: if any line in the result is very long
    // (exceeding maxBytes), we truncate the first such line.
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > maxBytes * 2) {
        const excess = lines[i].length - maxBytes;
        lines[i] = lines[i].slice(0, maxBytes) + `... [${excess} more bytes]`;
        truncated = true;
      }
    }
    content = lines.join('\n');

    return {
      content,
      truncated,
      totalBytes,
      returnedBytes: Buffer.byteLength(content, 'utf8'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readTail, TRUNCATION_MARKER };
