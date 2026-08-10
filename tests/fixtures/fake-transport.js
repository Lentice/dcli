/**
 * Fixture: an in-memory transport for the opencode transport seam (ticket 100).
 *
 * The adapter and turn module talk to the backend only through
 * `transport.request({ method, path, body, signal }) -> { status, headers,
 * body }` and `transport.events(path, { signal }) -> AsyncIterable`. This
 * fixture scripts those responses so the production reconciliation logic —
 * SSE reconnect, status polling, idle confirmation, the ticket-81 unknown
 * bound — runs for real against scripted HTTP.
 *
 * Scripting model: one `script` map keyed by path (query string stripped).
 *
 * - For `request`: the value is either a raw response `{ status, body }`
 *   (body is the raw text; `{ status: 204 }` implies an empty body), any
 *   other value (treated as a 200 JSON body), or a function
 *   `({ method, path, body }) => response` — including one that throws, to
 *   simulate a failing poll.
 * - For `events`: the value is an array of SSE events (each yielded in turn,
 *   then the stream closes), or a function returning such an array — called
 *   once per connection, so reconnect scenarios can return different events.
 *
 * The HTTP response shapes follow docs/reference/opencode-study.md: the
 * `/session/status` map, the message `parts` shape and the permission /
 * question arrays are exactly what the study verified live (1.18.7–1.18.12)
 * and what the adapter has always consumed.
 */
class FakeTransport {
  /**
   * @param {{ pid?: number|null, script?: object }} opts
   */
  constructor({ pid = 4242, script = {} } = {}) {
    this.pid = pid;
    this.script = script;
    this.calls = [];
  }

  async request({ method, path, body, signal }) {
    this.calls.push({ method, path, body });
    const key = path.split('?')[0];
    const scripted = this.script[key];
    if (scripted === undefined) {
      throw new Error(`FakeTransport: no scripted response for ${method} ${key}`);
    }
    const response = typeof scripted === 'function' ? scripted({ method, path, body }) : scripted;
    return this._normalize(response);
  }

  async *events(path, { signal }) {
    const key = path.split('?')[0];
    const scripted = this.script[key];
    if (scripted === undefined) return;
    const events = typeof scripted === 'function' ? scripted() : scripted;
    if (!Array.isArray(events)) return;
    for (const event of events) {
      yield event;
    }
  }

  _normalize(response) {
    if (response && typeof response === 'object' && typeof response.status === 'number') {
      return { status: response.status, headers: response.headers || {}, body: response.body !== undefined ? response.body : '' };
    }
    return { status: 200, headers: {}, body: JSON.stringify(response) };
  }
}

module.exports = { FakeTransport };
