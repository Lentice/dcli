const { requestJson } = require('./transport');
const { classifyBackendError } = require('./classify');

const POLL_INTERVAL_MS = 5000;
const INTERACTION_POLL_MS = 2000;
const IDLE_CONFIRM_MS = 3000;
const SSE_READ_TIMEOUT_MS = 3000;
const MAX_SSE_RECONNECTS = 5;
// How long after the prompt a session may still be missing from
// /session/status before its absence is taken to mean the turn is over.
// Bounds the "turn failed instantly" case, which otherwise never terminates.
const SESSION_REGISTRATION_GRACE_MS = 15000;
// How long the session status may stay unresolvable — 'unknown', or a status
// poll that keeps failing — before the turn's outcome is declared ambiguous.
// An unresolved status is not "still working": treating it as such polled the
// full hard-timeout budget and produced zero bytes (ticket 81).
const UNRESOLVED_STATUS_LIMIT_MS = 60000;
const MESSAGES_TIMEOUT_MS = 30000;
const SESSION_STATUS_TIMEOUT_MS = 10000;
// How long a REST-polled 'idle' status must be observed before it is treated
// as authoritative turn completion. This is deliberately short (a status
// poll is itself an immediate, reliable signal that the turn already
// finished) and is a distinct concept from SSE socket idle tolerance, which
// the transport owns.
const SSE_CONNECT_TIMEOUT_MS = 10000;

const DEFAULT_TIMINGS = Object.freeze({
  pollIntervalMs: POLL_INTERVAL_MS,
  interactionPollMs: INTERACTION_POLL_MS,
  idleConfirmMs: IDLE_CONFIRM_MS,
  sseReadTimeoutMs: SSE_READ_TIMEOUT_MS,
  maxSseReconnects: MAX_SSE_RECONNECTS,
  sessionRegistrationGraceMs: SESSION_REGISTRATION_GRACE_MS,
  unresolvedStatusLimitMs: UNRESOLVED_STATUS_LIMIT_MS,
  messagesTimeoutMs: MESSAGES_TIMEOUT_MS,
  sessionStatusTimeoutMs: SESSION_STATUS_TIMEOUT_MS,
  sseConnectTimeoutMs: SSE_CONNECT_TIMEOUT_MS,
});

/**
 * The opencode turn: SSE reconnect, REST status polling, interaction polling,
 * idle confirmation and the deadline, in one module (ticket 100).
 *
 * This is the logic that was spread across the adapter's Observe loop,
 * _fetchSessionStatus, _pollInteractions and _readMessagesFromServer — and it
 * is the logic the old _testMode branches bypassed. It talks to the backend
 * only through the injected transport seam, so a test supplies scripted HTTP
 * responses and SSE events and exercises the production reconciliation code.
 *
 * The adapter never declares terminality from here (invariant 2): this emits
 * the normalized fact stream (design-spec §9) and lets the engine's reducer
 * decide state. `run` emits `started` … facts … `process_exited`; the
 * collected result is read back from `result`.
 */
class OpencodeTurn {
  /**
   * @param {{ transport: object, buildPath: (endpoint: string) => string,
   *           timings?: Partial<typeof DEFAULT_TIMINGS> }} opts
   */
  constructor({ transport, buildPath, timings = {} }) {
    this._transport = transport;
    this._buildPath = buildPath;
    this._timings = { ...DEFAULT_TIMINGS, ...timings };

    this._sessionId = null;
    this._promptSentAt = null;
    this._sawLiveStatus = false;
    this._seenInteractionIds = new Set();
    this._policy = null;
    this._deadline = null;
    this._isCancelled = () => false;

    this._resultText = '';
    this._resultUsage = { input: 0, output: 0, total: 0 };
    this._resultCost = null;
    this._backendSessionId = null;
    this._factCount = 0;
    this._exitCode = null;
    this._hadBackendError = false;
  }

  get result() {
    return {
      text: this._resultText,
      usage: this._resultUsage,
      cost: this._resultCost,
      backendSessionId: this._backendSessionId,
    };
  }

  get factCount() { return this._factCount; }
  get exitCode() { return this._exitCode; }
  get hadBackendError() { return this._hadBackendError; }
  get seenInteractionCount() { return this._seenInteractionIds.size; }

  /**
   * Run one turn and yield the normalized fact stream.
   *
   * @param {{ prompt?: string|null, session: { id: string,
   *           promptSentAt?: number|null, backendPid?: number|null,
   *           containment?: object|null },
   *           policy?: object|null, deadline?: number|null,
   *           context?: { isCancelled?: () => boolean } }} opts
   */
  async *run({ prompt, session, policy, deadline, context = {} }) {
    this._sessionId = session.id;
    this._promptSentAt = session.promptSentAt || null;
    this._backendSessionId = session.id;
    this._policy = policy || null;
    this._deadline = deadline !== undefined ? deadline : null;
    this._isCancelled = context.isCancelled || (() => false);
    this._sawLiveStatus = false;
    this._seenInteractionIds = new Set();
    this._resultText = '';
    this._resultUsage = { input: 0, output: 0, total: 0 };
    this._resultCost = null;
    this._factCount = 0;
    this._exitCode = null;
    this._hadBackendError = false;

    yield this._record({
      type: 'started',
      backend_pid: session.backendPid || null,
      backend_session_id: session.id,
      ...(session.containment ? { containment: session.containment } : {}),
    });

    const POLL_MS = this._timings.pollIntervalMs;
    const SSE_TIMEOUT = this._timings.sseReadTimeoutMs;

    let sseLastId = null;
    let idleSince = null;
    let lastPoll = Date.now();
    let lastInteractionPoll = 0;
    let reconnectCount = 0;
    let statusCache = null;
    let unresolvedPolls = 0;
    let unresolvedExhausted = false;
    const maxUnresolvedPolls = Math.max(2, Math.ceil(this._timings.unresolvedStatusLimitMs / Math.max(1, POLL_MS)));

    const pollNow = async () => {
      try {
        statusCache = await this._fetchSessionStatus();
        return statusCache;
      } catch {
        // A failed poll leaves no opinion — but leaving the *previous* cache in
        // place made a transport error look like "never polled", which broke the
        // reconnect loop out and reported a partial turn as clean (ticket 81).
        statusCache = 'unknown';
        return null;
      }
    };

    while (reconnectCount < this._timings.maxSseReconnects) {
      if (this._isCancelled()) break;

      const sseGen = this._sseReadEvents(sseLastId);
      let sseDone = false;

      while (!sseDone) {
        if (this._isCancelled()) break;

        if (Date.now() - lastPoll >= POLL_MS) {
          lastPoll = Date.now();
          const s = await pollNow();
          // 'unknown' is not a reportable state (core/fact-types.js) and is
          // handled by the bound below, not published as progress.
          if (s && s !== 'unknown') yield this._record({ type: 'backend_status', state: s });

          if (!s || s === 'unknown') {
            unresolvedPolls++;
            // Counted, not clocked: consecutive polls are the thing that must be
            // bounded, and a count cannot be defeated by a loop that spins
            // several polls inside one millisecond (ticket 81).
            if (unresolvedPolls >= maxUnresolvedPolls) {
              yield this._record({
                type: 'backend_error',
                class_hint: 'backend_status_unresolved',
                structured_payload: {
                  message: `Backend session status was unresolvable for ${maxUnresolvedPolls} consecutive polls (last status: ${s || 'poll_failed'}). The turn's outcome is unknown; any result recorded may be incomplete.`,
                },
              });
              unresolvedExhausted = true;
              sseDone = true;
              break;
            }
          } else {
            unresolvedPolls = 0;
          }
        }

        if (Date.now() - lastInteractionPoll >= this._timings.interactionPollMs) {
          lastInteractionPoll = Date.now();
          if (this._deadline === null || Date.now() < this._deadline) {
            const interactions = await this._pollInteractions();
            for (const interaction of interactions) {
              yield this._record({ type: 'interaction_pending', interaction_id: interaction.interaction_id, kind: interaction.kind, detail: interaction.detail });
              if (!this._policy) {
                try {
                  await this._rejectInteraction(interaction);
                } catch (err) {
                  if (err && err.rejectFailed) {
                    yield this._record({ type: 'stream_closed', reason: 'interaction_reject_failed', detail: { interaction_id: interaction.interaction_id, error: err.message } });
                    break;
                  }
                  throw err;
                }
                yield this._record({ type: 'interaction_resolved', interaction_id: interaction.interaction_id, outcome: 'rejected_unattended' });
                const permPayload = interaction.raw ? { permission: interaction.raw.permission || null, patterns: interaction.raw.patterns || null } : {};
                yield this._record({
                  type: 'backend_error',
                  class_hint: 'permission_or_sandbox',
                  structured_payload: { ...permPayload, message: 'Interaction rejected: no authorized responder available' },
                });
              }
            }
          }
        }

        if (statusCache === 'idle') {
          if (idleSince === null) {
            idleSince = Date.now();
          } else if (Date.now() - idleSince > this._timings.idleConfirmMs) {
            sseDone = true;
            break;
          }
        } else {
          idleSince = null;
        }

        const nextResult = await this._readSseWithTimeout(sseGen, SSE_TIMEOUT);

        if (nextResult === null) continue;

        if (nextResult.done) {
          yield this._record({ type: 'stream_closed', reason: 'sse_disconnect' });
          sseDone = true;
          break;
        }

        const event = nextResult.value;
        const sseId = event._sseId || null;
        if (sseId) sseLastId = sseId;

        const events = Array.isArray(event) ? event : [event];
        const facts = this._processSseEvents(events);
        for (const f of facts) yield this._record(f);
        idleSince = null;
      }

      if (this._isCancelled() || unresolvedExhausted) break;

      reconnectCount++;

      if (statusCache === null || statusCache === 'idle') {
        break;
      }

      if (reconnectCount >= this._timings.maxSseReconnects) {
        break;
      }

      try {
        const gapMsgs = await this._readMessagesFromServer();
        if (gapMsgs) {
          const gf = this._processMessageFacts(gapMsgs);
          for (const f of gf) yield this._record(f);
        }
      } catch {}
    }

    if (!this._isCancelled()) {
      try {
        const msgs = await this._readMessagesFromServer();
        const final = this._selectFinalMessage(msgs);
        this._resultText = final.text;
        this._resultUsage = final.usage;
        this._resultCost = final.cost;
        // An assistant turn that failed carries its error on the message, and
        // nothing here used to read it — so a provider refusal surfaced as a
        // successful job with an empty result. Emit it as a fact and let the
        // engine decide the state.
        const msgError = this._findMessageError(msgs);
        if (msgError) {
          yield this._record({
            type: 'backend_error',
            class_hint: msgError.class_hint,
            structured_payload: { message: msgError.message, name: msgError.name, status_code: msgError.statusCode },
          });
        }

        // A zero-token result where the server accepted the session but
        // produced no assistant messages at all means the model was not
        // viable (invalid/unreachable provider). Without this, opencode
        // silently returns only the prompt message as the result.
        // This is distinct from a legitimate empty completion where an
        // assistant message exists but produces no text.
        const hasAssistantMessages = Array.isArray(msgs) && msgs.some(msg => {
          const info = msg && msg.info;
          return !info || info.role === 'assistant';
        });
        const totalTokens = (final.usage && final.usage.total) || 0;
        if (!msgError && totalTokens === 0 && !hasAssistantMessages) {
          yield this._record({
            type: 'backend_error',
            class_hint: 'provider_error',
            structured_payload: {
              message: 'Backend session completed without running the model. The provider/model may be invalid, unreachable, or configured incorrectly.',
            },
          });
        }
        if (final.text) {
          yield this._record({ type: 'assistant_text', message_id: final.message_id || this._sessionId || 'msg_final', text: final.text });
        }
        yield this._record({
          type: 'usage_reported',
          tokens: final.usage,
          cost: final.cost,
        });
      } catch (err) {
        yield this._record({ type: 'stream_closed', reason: 'finalization_error' });
      }
    }

    yield this._record({ type: 'process_exited', code: 0 });
  }

  _record(fact) {
    this._factCount++;
    if (fact.type === 'process_exited') this._exitCode = fact.code !== undefined ? fact.code : null;
    if (fact.type === 'backend_error') this._hadBackendError = true;
    return fact;
  }

  // -------------------------------------------------------------------------
  // Status / messages / interactions
  // -------------------------------------------------------------------------

  async _fetchSessionStatus() {
    const status = await requestJson(this._transport, {
      method: 'GET',
      path: this._buildPath('/session/status'),
      timeoutMs: this._timings.sessionStatusTimeoutMs,
    });
    if (status && typeof status === 'object') {
      const sid = this._sessionId;
      if (sid && status[sid]) {
        const t = status[sid].type || status[sid];
        if (typeof t === 'string') {
          this._sawLiveStatus = true;
          return t === 'retry' ? 'retrying' : t;
        }
        if (t && typeof t === 'object' && t.type) {
          this._sawLiveStatus = true;
          return t.type === 'retry' ? 'retrying' : t.type;
        }
      }

      // `/session/status` lists only sessions with work in flight, so once the
      // turn is over ours is simply absent and the map comes back `{}`.
      // Reporting that as 'unknown' meant the reconciliation loop — which
      // terminates only on a confirmed 'idle' — never terminated (ticket 81,
      // study §6: absence is the completion signal, verified live 1.18.10).
      //
      // Guarded so a session that has not yet been registered is not read as
      // finished. Observing it live once is the strong signal, but it cannot be
      // the only one: a turn that fails in the first few seconds — the case
      // this exists for — can be gone before the first poll ever sees it. So a
      // registration grace period counted from the prompt also qualifies.
      if (this._sawLiveStatus) return 'idle';
      if (this._promptSentAt && Date.now() - this._promptSentAt > this._timings.sessionRegistrationGraceMs) {
        return 'idle';
      }
    }
    return 'unknown';
  }

  async _readMessagesFromServer() {
    return requestJson(this._transport, {
      method: 'GET',
      path: this._buildPath(`/session/${this._sessionId}/message`),
      timeoutMs: this._timings.messagesTimeoutMs,
    });
  }

  async _pollInteractions() {
    const results = [];
    try {
      const perms = await requestJson(this._transport, {
        method: 'GET',
        path: this._buildPath('/permission'),
        timeoutMs: 5000,
      });
      if (Array.isArray(perms)) {
        for (const p of perms) {
          if (p && p.id && !this._seenInteractionIds.has(p.id)) {
            this._seenInteractionIds.add(p.id);
            results.push({
              interaction_id: p.id,
              kind: 'permission',
              detail: `${p.permission || 'unknown'}: ${(p.patterns || []).join(', ')}`,
              raw: p,
            });
          }
        }
      }
    } catch {
    }
    try {
      const questions = await requestJson(this._transport, {
        method: 'GET',
        path: this._buildPath('/question'),
        timeoutMs: 5000,
      });
      if (Array.isArray(questions)) {
        for (const q of questions) {
          if (q && q.id && !this._seenInteractionIds.has(q.id)) {
            this._seenInteractionIds.add(q.id);
            const topic = (q.questions || []).map(x => (typeof x === 'string' ? x : x.question || '')).join(', ');
            results.push({
              interaction_id: q.id,
              kind: 'question',
              detail: topic,
              raw: q,
            });
          }
        }
      }
    } catch {
    }
    return results;
  }

  async _rejectInteraction(interaction) {
    try {
      if (interaction.kind === 'question') {
        await requestJson(this._transport, {
          method: 'POST',
          path: this._buildPath(`/question/${interaction.interaction_id}/reject`),
          body: {},
          timeoutMs: 5000,
        });
      } else {
        await requestJson(this._transport, {
          method: 'POST',
          path: this._buildPath(`/permission/${interaction.interaction_id}/reply`),
          body: {
            reply: 'reject',
            message: 'Automatically rejected: no authorized responder is available to answer this permission request. Provide an automation policy or run interactively.',
          },
          timeoutMs: 5000,
        });
      }
    } catch (err) {
      if (err && err.statusCode === 404) return;
      const wrapped = new Error(`Failed to reject interaction ${interaction.interaction_id}: ${err.message}`);
      wrapped.rejectFailed = true;
      wrapped.cause = err;
      throw wrapped;
    }
  }

  // -------------------------------------------------------------------------
  // SSE
  // -------------------------------------------------------------------------

  async *_sseReadEvents(lastEventId) {
    const headers = {};
    if (lastEventId) {
      headers['Last-Event-ID'] = lastEventId;
    }
    for await (const event of this._transport.events(this._buildPath('/event'), {
      signal: AbortSignal.timeout(this._timings.sseConnectTimeoutMs),
    })) {
      yield event;
    }
  }

  async _readSseWithTimeout(sseIterator, timeoutMs) {
    const timeout = new Promise(resolve => {
      const t = setTimeout(() => resolve(null), timeoutMs);
      if (t.unref) t.unref();
    });
    const result = await Promise.race([
      sseIterator.next().then(r => r, () => ({ done: true })),
      timeout,
    ]);
    return result;
  }

  // -------------------------------------------------------------------------
  // Event / message parsing
  // -------------------------------------------------------------------------

  _processSseEvents(events) {
    const facts = [];
    for (const event of events) {
      const part = event.part || {};
      const eventType = event.type || '';
      const partType = part.type || '';

      switch (eventType) {
        case 'text': {
          if (partType === 'text' && typeof part.text === 'string') {
            facts.push({ type: 'assistant_text', message_id: part.messageID || 'msg_unknown', text: part.text });
          } else if (partType === 'reasoning') {
            facts.push({ type: 'reasoning', message_id: part.messageID || 'msg_unknown' });
          }
          break;
        }

        case 'tool_use': {
          if (partType === 'tool' && part.tool) {
            const callId = part.callID || 'call_unknown';
            const isRunning = part.state && (part.state.status === 'running' || part.state.status === 'pending');
            if (isRunning) {
              const inputSummary = part.state && part.state.input
                ? (part.state.input.command || part.state.input.file || JSON.stringify(part.state.input).slice(0, 100))
                : part.tool;
              facts.push({ type: 'tool_invoked', call_id: callId, tool: part.tool, summary: inputSummary });
            } else {
              const ok = part.state && part.state.metadata ? part.state.metadata.exit === 0 : null;
              const outputSummary = part.state && part.state.output
                ? String(part.state.output).slice(0, 200)
                : (part.tool || '');
              facts.push({ type: 'tool_result', call_id: callId, ok, summary: outputSummary });
            }
          }
          break;
        }

        case 'step_finish':
        case 'step-finish': {
          if (part.reason === 'stop' && part.tokens) {
            facts.push({
              type: 'usage_reported',
              tokens: {
                total: part.tokens.total || 0,
                input: part.tokens.input || 0,
                output: part.tokens.output || 0,
              },
              cost: part.cost !== undefined ? part.cost : null,
            });
          }
          break;
        }

        case 'error': {
          const payload = event.error || event;
          const classHint = classifyBackendError(payload);
          facts.push({
            type: 'backend_error',
            class_hint: classHint || 'provider_error',
            structured_payload: typeof payload === 'object' ? payload : { message: String(payload) },
          });
          break;
        }

        default:
          break;
      }
    }
    return facts;
  }

  _processMessageFacts(messagesResponse) {
    let messages = [];
    if (Array.isArray(messagesResponse)) {
      messages = messagesResponse;
    } else if (messagesResponse && Array.isArray(messagesResponse.messages)) {
      messages = messagesResponse.messages;
    } else if (messagesResponse && Array.isArray(messagesResponse.parts)) {
      messages = [{ parts: messagesResponse.parts }];
    }
    const facts = [];
    for (const msg of messages) {
      const parts = msg.parts || [];
      for (const p of parts) {
        switch (p.type || '') {
          case 'text':
            facts.push({ type: 'assistant_text', message_id: p.messageID || 'msg_gap', text: p.text || '' });
            break;
          case 'reasoning':
            facts.push({ type: 'reasoning', message_id: p.messageID || 'msg_gap' });
            break;
          default:
            break;
        }
      }
    }
    return facts;
  }

  /**
   * The error an assistant turn ended on, from `/session/:id/message`.
   *
   * opencode records a failed turn as a normal message carrying `info.error`;
   * there is no separate failure signal to observe, so this is the only place
   * a provider refusal is visible once the SSE stream has closed (study §6).
   *
   * @param {*} messageResponse
   * @returns {{ message: string, name: string|null, statusCode: number|null,
   *             class_hint: string }|null}
   */
  _findMessageError(messageResponse) {
    let messages = [];
    if (Array.isArray(messageResponse)) messages = messageResponse;
    else if (messageResponse && Array.isArray(messageResponse.messages)) messages = messageResponse.messages;
    else return null;

    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i] && messages[i].info;
      const err = info && info.error;
      if (!err) continue;
      const data = err.data || {};
      return {
        message: data.message || err.message || err.name || 'Backend reported an error',
        name: err.name || null,
        statusCode: typeof data.statusCode === 'number' ? data.statusCode : null,
        class_hint: classifyBackendError(data) || classifyBackendError(err) || 'provider_error',
      };
    }
    return null;
  }

  _selectFinalMessage(messageResponse) {
    let messages = [];
    if (Array.isArray(messageResponse)) {
      messages = messageResponse;
    } else if (messageResponse && Array.isArray(messageResponse.messages)) {
      messages = messageResponse.messages;
    } else if (messageResponse && Array.isArray(messageResponse.parts)) {
      messages = [{ parts: messageResponse.parts }];
    }

    let lastCompletedMid = null;
    let hasInfoIds = false;
    let finalFlatMid = null;

    for (const msg of messages) {
      const info = msg.info;
      // Skip explicit user messages; messages without info (flat parts shape)
      // are treated as assistant.
      if (info && info.role === 'user') continue;
      const parts = msg.parts || [];
      const hasStop = parts.some(p => (p.type === 'step-finish' || p.type === 'step_finish') && p.reason === 'stop');
      if (hasStop) {
        if (info && info.id) {
          lastCompletedMid = info.id;
          hasInfoIds = true;
        } else {
          lastCompletedMid = null;
          const stopPart = parts.find(p => (p.type === 'step-finish' || p.type === 'step_finish') && p.reason === 'stop');
          finalFlatMid = stopPart ? stopPart.messageID || null : null;
        }
      }
    }

    // Only consider assistant messages — user messages (the prompt and its
    // echo) must never be picked up as the result. An invalid model that
    // produces no assistant turn at all must yield an empty result.
    // When a message has no info (e.g. the flat { parts: [...] } shape
    // mapped at the top of this function), treat it as an assistant message
    // because the adapter itself constructs that shape from API responses
    // which do not include role metadata.
    const assistantMessages = messages.filter(msg => {
      const info = msg && msg.info;
      if (!info) return true;
      return info.role === 'assistant';
    });

    let text = '';
    let usage = { input: 0, output: 0, total: 0 };
    let cost = null;

    if (hasInfoIds) {
      for (const msg of assistantMessages) {
        if (msg.info && msg.info.id !== lastCompletedMid) continue;
        const parts = msg.parts || [];
        for (const p of parts) {
          if (p.type === 'text') text += p.text || '';
          if ((p.type === 'step-finish' || p.type === 'step_finish') && p.tokens) {
            usage = {
              total: p.tokens.total || 0,
              input: p.tokens.input || 0,
              output: p.tokens.output || 0,
              reasoning: p.tokens.reasoning || null,
              cache_read: (p.tokens.cache && p.tokens.cache.read) || null,
              cache_write: (p.tokens.cache && p.tokens.cache.write) || null,
            };
            if (p.cost !== undefined) cost = p.cost;
          }
        }
      }
      return { text, usage, cost, message_id: lastCompletedMid };
    }

    if (finalFlatMid) {
      const parts = assistantMessages.length > 0 ? assistantMessages[0].parts || [] : [];
      for (const p of parts) {
        if (p.messageID !== finalFlatMid) continue;
        if (p.type === 'text') text += p.text || '';
        if ((p.type === 'step-finish' || p.type === 'step_finish') && p.tokens) {
          usage = {
            total: p.tokens.total || 0,
            input: p.tokens.input || 0,
            output: p.tokens.output || 0,
            reasoning: p.tokens.reasoning || null,
            cache_read: (p.tokens.cache && p.tokens.cache.read) || null,
            cache_write: (p.tokens.cache && p.tokens.cache.write) || null,
          };
          if (p.cost !== undefined) cost = p.cost;
        }
      }
      return { text, usage, cost, message_id: finalFlatMid };
    }

    if (assistantMessages.length === 0) {
      return { text: '', usage: { input: 0, output: 0, total: 0 }, cost: null, message_id: null };
    }

    const parts = assistantMessages[0].parts || [];
    for (const p of parts) {
      if (p.type === 'text') text += p.text || '';
      if ((p.type === 'step-finish' || p.type === 'step_finish') && p.tokens) {
        usage = {
          total: p.tokens.total || 0,
          input: p.tokens.input || 0,
          output: p.tokens.output || 0,
          reasoning: p.tokens.reasoning || null,
          cache_read: (p.tokens.cache && p.tokens.cache.read) || null,
          cache_write: (p.tokens.cache && p.tokens.cache.write) || null,
        };
        if (p.cost !== undefined) cost = p.cost;
      }
    }
    return { text, usage, cost, message_id: null };
  }
}

module.exports = { OpencodeTurn, DEFAULT_TIMINGS };
