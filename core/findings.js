const path = require('path');

const APPENDIX_MARKER = '<!-- dcli:findings -->';
const MAX_APPENDIX_BYTES = 100 * 1024;
const MAX_ITEMS = 100;
const KNOWN_SEVERITIES = new Set(['critical', 'important', 'minor']);

function parseFindings(text) {
  if (!text || typeof text !== 'string') {
    return { status: 'absent', data: null, items: null, error: null, proseBefore: text || '' };
  }

  const textBeforeMarker = { value: '' };
  const markerPositions = findAllMarkers(text);
  if (markerPositions.length === 0) {
    return { status: 'absent', data: null, items: null, error: null, proseBefore: text };
  }

  if (markerPositions.length > 1) {
    const markerEnd = markerPositions[markerPositions.length - 1].end;
    textBeforeMarker.value = text.slice(0, markerPositions[0].start);
    return {
      status: 'malformed',
      data: null,
      items: null,
      proseBefore: textBeforeMarker.value,
      error: `Duplicate findings marker found (${markerPositions.length} occurrences)`,
    };
  }

  const marker = markerPositions[0];
  const afterMarker = text.slice(marker.end);

  textBeforeMarker.value = text.slice(0, marker.start);

  const trimmedAfter = afterMarker.trimStart();
  const trailingStart = marker.end + (afterMarker.length - trimmedAfter.length);

  if (!trimmedAfter.startsWith('```json')) {
    return {
      status: 'malformed',
      data: null,
      items: null,
      proseBefore: textBeforeMarker.value,
      error: 'Expected ```json block after findings marker',
    };
  }

  const afterFenceStart = trimmedAfter.slice('```json'.length);
  const trimmedAfterFence = afterFenceStart.trimStart();
  const jsonStart = marker.end + (afterMarker.length - trimmedAfter.length) + '```json'.length + (afterFenceStart.length - trimmedAfterFence.length);

  const fenceEndIndex = trimmedAfterFence.indexOf('\n```');
  if (fenceEndIndex === -1) {
    return {
      status: 'malformed',
      data: null,
      items: null,
      proseBefore: textBeforeMarker.value,
      error: 'Truncated JSON code block — missing closing ```',
    };
  }

  const jsonContent = trimmedAfterFence.slice(0, fenceEndIndex);
  const afterClosingFence = trimmedAfterFence.slice(fenceEndIndex + '\n```'.length);

  const appendixStart = marker.start;
  const appendixEnd = jsonStart + jsonContent.length + (trimmedAfterFence.length - (trimmedAfterFence.length - fenceEndIndex - '\n```'.length)) + 10;

  if (jsonContent.length > MAX_APPENDIX_BYTES) {
    return {
      status: 'malformed',
      data: null,
      items: null,
      proseBefore: textBeforeMarker.value,
      error: `Appendix exceeds size limit (${jsonContent.length} > ${MAX_APPENDIX_BYTES} bytes)`,
    };
  }

  const trailingTrimmed = afterClosingFence.trim();
  if (trailingTrimmed.length > 0) {
    return {
      status: 'malformed',
      data: null,
      items: null,
      proseBefore: textBeforeMarker.value,
      error: 'Trailing content found after findings appendix',
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonContent);
  } catch (e) {
    return {
      status: 'malformed',
      data: null,
      items: null,
      proseBefore: textBeforeMarker.value,
      error: `Failed to parse findings JSON: ${e.message}`,
    };
  }

  const validationError = validateFindingsData(parsed);
  if (validationError) {
    return {
      status: 'malformed',
      data: null,
      items: null,
      proseBefore: textBeforeMarker.value,
      error: validationError,
    };
  }

  return {
    status: 'ok',
    data: parsed,
    items: parsed.items,
    error: null,
    proseBefore: textBeforeMarker.value,
  };
}

function findAllMarkers(text) {
  const positions = [];
  let idx = 0;
  while (idx < text.length) {
    const found = text.indexOf(APPENDIX_MARKER, idx);
    if (found === -1) break;
    positions.push({ start: found, end: found + APPENDIX_MARKER.length });
    idx = found + APPENDIX_MARKER.length;
  }
  return positions;
}

// Deliberately platform-independent: a findings appendix is untrusted input and
// may have been produced anywhere, so a Windows-absolute path is rejected even
// when the parser happens to be running on POSIX, and vice versa. Uses
// path.isAbsolute() only as a supplement — its answer depends on the host.
function isAbsolutePath(p) {
  if (p.startsWith('/') || p.startsWith('\\')) return true;   // POSIX root, UNC, rooted-drive-relative
  if (/^[A-Za-z]:[/\\]/.test(p)) return true;                 // C:\... or C:/...
  if (/^[A-Za-z]:/.test(p)) return true;                      // C:foo — drive-relative, still not repo-relative
  return path.isAbsolute(p);
}

function validateFindingsData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'Findings data must be a JSON object';
  }

  if (typeof data.verdict !== 'string' || data.verdict.trim().length === 0) {
    return 'Verdict must be a non-empty string';
  }

  if (!Array.isArray(data.items)) {
    return 'Items must be an array';
  }

  if (data.items.length > MAX_ITEMS) {
    return `Item count (${data.items.length}) exceeds limit (${MAX_ITEMS})`;
  }

  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    if (!item || typeof item !== 'object') {
      return `Item ${i} must be an object`;
    }

    if (typeof item.severity !== 'string' || !KNOWN_SEVERITIES.has(item.severity)) {
      return `Item ${i}: severity must be one of: ${[...KNOWN_SEVERITIES].join(', ')}, got "${item.severity}"`;
    }

    if (typeof item.claim !== 'string' || item.claim.trim().length === 0) {
      return `Item ${i}: claim must be a non-empty string`;
    }

    if (item.file !== null && item.file !== undefined) {
      if (typeof item.file !== 'string') {
        return `Item ${i}: file must be a string or null`;
      }
      // Absolute in every form this tool can encounter, not just POSIX. win32
      // is the primary platform, so a leading-slash check alone let
      // `C:\Windows\...`, `D:/...` and `\\server\share\...` through as
      // "repository-relative" — the one thing this validation exists to stop.
      if (isAbsolutePath(item.file)) {
        return `Item ${i}: absolute path "${item.file}" is not allowed`;
      }
      if (item.file.includes('..')) {
        const parts = item.file.split(/[/\\]/);
        for (const part of parts) {
          if (part === '..') {
            return `Item ${i}: path traversal "${item.file}" is not allowed`;
          }
        }
      }
    }

    if (item.line !== null && item.line !== undefined && typeof item.line !== 'number') {
      return `Item ${i}: line must be a number or null`;
    }

    if (item.evidence !== null && item.evidence !== undefined && typeof item.evidence !== 'string') {
      return `Item ${i}: evidence must be a string or null`;
    }

    if (item.suggested_fix !== null && item.suggested_fix !== undefined && typeof item.suggested_fix !== 'string') {
      return `Item ${i}: suggested_fix must be a string or null`;
    }
  }

  return null;
}

module.exports = { parseFindings, APPENDIX_MARKER, MAX_ITEMS, KNOWN_SEVERITIES };
