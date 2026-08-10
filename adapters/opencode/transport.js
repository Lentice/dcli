const http = require('node:http');
const { classifyBackendError } = require('./classify');

const DEFAULT_TIMEOUT_MS = 10000;
// Socket idle timeout for the long-lived SSE connection itself. Must be
// comfortably longer than any real model turn's gaps between SSE bytes —
// this connection legitimately sits with no activity for a while during a
// long turn, and a short value here tears down a still-useful connection
// purely due to elapsed wall-clock time.
const SSE_SOCKET_TIMEOUT_MS = 600000;
// Bounds connection establishment for the SSE source. The stream itself is
// bounded per-read by the turn module and by the socket idle timeout above.
const SSE_CONNECT_TIMEOUT_MS = 10000;

/**
 * Raw HTTP + SSE transport for one per-job opencode server.
 *
 * This is the transport seam of ticket 100: the adapter and the turn module
 * talk to `request` / `events` and nothing else, so a test can substitute an
 * in-memory transport and exercise the production reconciliation logic.
 *
 * `request` resolves `{ status, headers, body }` with the raw text body — it
 * does not parse, and it does not throw on non-2xx; callers that want the
 * parsed-JSON semantics use `requestJson`. Every call must supply a finite
 * `signal` (AbortController bound, invariant 3); the transport asserts it.
 */
class HttpTransport {
  /**
   * @param {{ baseUrl: string, password?: string|null }} opts
   */
  constructor({ baseUrl, password = null }) {
    this._baseUrl = baseUrl;
    this._password = password;
  }

  /**
   * @param {{ method: string, path: string, body?: object, headers?: object,
   *           signal: AbortSignal }} opts
   * @returns {Promise<{ status: number, headers: object, body: string }>}
   */
  async request({ method, path, body, headers = {}, signal }) {
    if (!signal) {
      throw new Error('transport.request requires a signal: every HTTP call must be bounded');
    }
    const hdrs = { ...headers };
    if (body !== undefined && body !== null) hdrs['Content-Type'] = 'application/json';
    if (this._password) {
      hdrs['Authorization'] = 'Basic ' + Buffer.from('opencode:' + this._password).toString('base64');
    }

    const url = this._baseUrl + path;
    let res;
    let raw;
    try {
      res = await fetch(url, {
        method,
        headers: hdrs,
        body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
        signal,
      });
      raw = await res.text();
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        const timedOut = new Error(`Request timed out: ${method} ${path}`);
        timedOut.name = 'TimeoutError';
        throw timedOut;
      }
      throw err;
    }

    return { status: res.status, headers: res.headers, body: raw };
  }

  /**
   * The SSE source: `GET <base>/<path>` parsed into events.
   *
   * Yields each event's parsed JSON data, decorated with `_sseId` and
   * `_sseEvent` from the SSE framing (top-level `type` uses underscores,
   * `part.type` uses hyphens — both arrive untouched, see study §4). An empty
   * event has no data and is skipped; malformed JSON data is skipped, never
   * fatal (unknown event types are non-fatal, study §6).
   *
   * @param {string} path
   * @param {{ signal: AbortSignal }} opts  bounds connection establishment
   * @returns {AsyncIterable<object>}
   */
  async *events(path, { signal }) {
    const u = new URL(this._baseUrl + path);
    const headers = {};
    if (this._password) {
      headers['Authorization'] = 'Basic ' + Buffer.from('opencode:' + this._password).toString('base64');
    }

    const response = await new Promise((resolve, reject) => {
      const req = http.get({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers,
        timeout: SSE_SOCKET_TIMEOUT_MS,
      }, (res) => { resolve(res); });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('SSE connection timed out'));
      });
      if (signal) {
        signal.addEventListener('abort', () => {
          req.destroy();
          reject(new Error('SSE connection setup aborted'));
        }, { once: true });
      }
    });

    let buffer = '';
    let sseId = null;

    try {
      for await (const chunkRaw of response) {
        buffer += chunkRaw.toString('utf8');

        while (buffer.includes('\n\n')) {
          const idx = buffer.indexOf('\n\n');
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          const parsed = this._parseSseBlock(block);
          if (!parsed) continue;

          if (parsed.id) sseId = parsed.id;
          if (!parsed.data || parsed.data.length === 0) continue;

          try {
            const data = JSON.parse(parsed.data);
            if (sseId) data._sseId = sseId;
            if (parsed.event) data._sseEvent = parsed.event;
            yield data;
          } catch {}
        }
      }
    } catch (err) {
      return;
    }
  }

  _parseSseBlock(block) {
    const lines = block.split('\n');
    const event = { data: [] };
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const field = line.slice(0, colonIdx);
      let value = line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event.event = value;
      else if (field === 'data') event.data.push(value);
      else if (field === 'id') event.id = value;
      else if (field === 'retry') event.retry = parseInt(value, 10);
    }
    if (event.data.length === 0) return null;
    event.data = event.data.join('\n');
    return event;
  }
}

/**
 * One bounded JSON request over a transport, in the semantics the adapter and
 * turn module rely on:
 *
 * - resolves the parsed JSON body (or the raw text when it is not JSON);
 * - a non-2xx rejects with statusCode/body attached, and classHint set when
 *   the payload identifies a credits/quota failure (classify.js);
 * - the AbortSignal.timeout bounds connect, response and body read together.
 *
 * @param {HttpTransport|object} transport  anything with request({...})
 * @param {{ method: string, path: string, body?: object, timeoutMs?: number }} opts
 */
async function requestJson(transport, { method, path, body, timeoutMs }) {
  const effectiveTimeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  let res;
  try {
    res = await transport.request({
      method,
      path,
      body,
      signal: AbortSignal.timeout(effectiveTimeout),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`Request timed out after ${effectiveTimeout}ms: ${method} ${path}`);
    }
    throw err;
  }

  if (res.status >= 200 && res.status < 300) {
    try {
      return JSON.parse(res.body);
    } catch {
      return res.body;
    }
  }

  const err = new Error(`HTTP ${res.status} from ${method} ${path}: ${String(res.body).slice(0, 500)}`);
  err.statusCode = res.status;
  err.body = res.body;
  try {
    const parsed = JSON.parse(res.body);
    if (parsed && parsed.error && classifyBackendError(parsed) === 'quota_or_rate_limit') {
      err.classHint = 'quota_or_rate_limit';
    }
  } catch {}
  throw err;
}

module.exports = {
  HttpTransport,
  requestJson,
  DEFAULT_TIMEOUT_MS,
  SSE_SOCKET_TIMEOUT_MS,
  SSE_CONNECT_TIMEOUT_MS,
};
