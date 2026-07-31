const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
const { buildCmdInvocation } = require('../codex/cmd-quoting');
const { getRedactor } = require('../../core/fs-text');

const PORT_RESERVE_MAX_RETRIES = 5;
const PORT_RESERVE_TIMEOUT_MS = 5000;
const STARTUP_TIMEOUT_MS = 30000;
const HEALTH_TIMEOUT_MS = 10000;
const SESSION_TIMEOUT_MS = 10000;
const PROJECT_CHECK_TIMEOUT_MS = 10000;
const DISPOSE_TIMEOUT_MS = 5000;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_BYTES = 10 * 1024 * 1024;
const POLL_INTERVAL_MS = 5000;
const INTERACTION_POLL_MS = 2000;
const IDLE_TIMEOUT_MS = 120000;
const SSE_READ_TIMEOUT_MS = 3000;
// How long a REST-polled 'idle' status must be observed before it is treated
// as authoritative turn completion. This is deliberately short (a status
// poll is itself an immediate, reliable signal that the turn already
// finished) and is a distinct concept from IDLE_TIMEOUT_MS, which bounds SSE
// connection keepalive/staleness tolerance, not backend-idle confirmation.
const IDLE_CONFIRM_MS = 3000;
// Socket idle timeout for the long-lived SSE connection itself. Must be
// comfortably longer than any real model turn's gaps between SSE bytes —
// this connection legitimately sits with no activity for a while during a
// long turn, and a short value here tears down a still-useful connection
// purely due to elapsed wall-clock time.
const SSE_SOCKET_TIMEOUT_MS = 600000;
const PROMPT_ASYNC_TIMEOUT_MS = 15000;
// How long after the prompt a session may still be missing from
// /session/status before its absence is taken to mean the turn is over.
// Bounds the "turn failed instantly" case, which otherwise never terminates.
const SESSION_REGISTRATION_GRACE_MS = 15000;
const MESSAGES_TIMEOUT_MS = 30000;
const SESSION_STATUS_TIMEOUT_MS = 10000;
const MAX_SSE_RECONNECTS = 5;

/**
 * One bounded JSON request to the per-job opencode server.
 *
 * The single AbortSignal.timeout bounds connect, response and body read
 * together — a stalled body is inside the budget, which is what the old
 * hand-rolled socket-timeout-plus-wall-clock-timer pair was for.
 *
 * Resolves the parsed JSON body (or the raw text when it is not JSON).
 * A non-2xx rejects with statusCode/body attached, and classHint set when
 * the payload identifies a credits/quota failure.
 */
async function httpRequest(method, url, body, timeoutMs, password) {
  const effectiveTimeout = timeoutMs || 10000;
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  if (password) {
    headers['Authorization'] = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
  }

  let res;
  let raw;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(effectiveTimeout),
    });
    raw = await res.text();
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`Request timed out after ${effectiveTimeout}ms: ${method} ${url}`);
    }
    throw err;
  }

  if (res.ok) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  const err = new Error(`HTTP ${res.status} from ${method} ${url}: ${raw.slice(0, 500)}`);
  err.statusCode = res.status;
  err.body = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.error && parsed.error.type === 'CreditsError') {
      err.classHint = 'quota_or_rate_limit';
    }
  } catch {}
  throw err;
}

function httpGet(url, opts = {}) {
  return httpRequest('GET', url, null, opts.responseTimeout, opts.password);
}

function httpPost(url, body, opts = {}) {
  return httpRequest('POST', url, body, opts.responseTimeout, opts.password);
}

const ENDPOINTS_WITHOUT_DIR_PREFIXES = [
  '/global/', '/instance/', '/event', '/doc',
  '/agent', '/skill', '/command', '/lsp',
  '/provider',
];

function resolvePastBunShim(shimPath) {
  function checkBunPrefix(prefix) {
    try {
      const p = path.join(prefix, 'install', 'global', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
      if (fs.existsSync(p)) return p;
    } catch {}
    return null;
  }

  if (process.env.BUN_INSTALL) {
    const fromEnv = checkBunPrefix(process.env.BUN_INSTALL);
    if (fromEnv) return fromEnv;
  }

  try {
    const result = require('node:child_process').execSync('bun pm bin -g', {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    const binDir = result.trim().split('\n')[0].trim();
    if (binDir) {
      const prefix = path.dirname(binDir);
      const fromBun = checkBunPrefix(prefix);
      if (fromBun) return fromBun;
    }
  } catch {}

  const normalized = shimPath.replace(/\\/g, '/').toLowerCase();
  const marker = '.bun/bin/opencode.exe';
  const idx = normalized.indexOf(marker);
  if (idx !== -1) {
    const prefix = shimPath.substring(0, idx + 4);
    const fromShim = checkBunPrefix(prefix);
    if (fromShim) return fromShim;
  }

  return null;
}

function resolveOpencodePath() {
  if (process.env.OPENCODE_PATH) return process.env.OPENCODE_PATH;

  const { execSync } = require('node:child_process');

  let resolved = null;

  try {
    const result = execSync('where opencode 2>nul || which opencode 2>/dev/null', {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const line = result.trim().split('\n')[0].trim();
    if (line) resolved = line;
  } catch {}

  if (!resolved) return 'opencode';

  const realPath = resolvePastBunShim(resolved);
  return realPath || resolved;
}

class OpencodeAdapter {
  constructor(options = {}) {
    this._testMode = options._testMode || false;
    this._mockVersion = options._mockVersion || null;
    this._mockFacts = options._mockFacts !== undefined ? options._mockFacts : null;
    this._mockExitCode = options._mockExitCode !== undefined ? options._mockExitCode : null;
    this._mockSseEvents = options._mockSseEvents || null;
    this._mockSessionStatusResponses = options._mockSessionStatusResponses || null;
    this._mockMessagesResponse = options._mockMessagesResponse || null;
    this._mockPromptAsyncStatusCode = options._mockPromptAsyncStatusCode !== undefined ? options._mockPromptAsyncStatusCode : 204;
    this._mockSessionId = options._mockSessionId || null;
    this._mockIdleTimeoutMs = options._mockIdleTimeoutMs || null;
    this._stateRoot = options.stateRoot || null;
    this._jobId = options.jobId || null;

    this._password = null;
    this._serverProcess = null;
    this._serverPort = null;
    this._serverBaseUrl = null;
    this._sessionId = null;
    this._backendPid = null;
    this._backendSessionId = null;
    this._facts = [];
    this._collectedResult = null;
    this._detectedVersion = null;
    this._disposed = false;
    this._cancelled = false;
    this._cancelRungReached = null;
    this._serverStdout = '';
    this._serverStderr = '';
    this._serverHandle = null;
    this._creationTime = null;
    this._imagePath = null;
    this._executionToken = null;

    this._canonicalDir = null;
    this._accessMode = null;
    this._lastPermissionRuleset = null;
    this._modelObj = null;
    this._variant = null;

    this._startupTimeoutMs = STARTUP_TIMEOUT_MS;
    this._healthTimeoutMs = HEALTH_TIMEOUT_MS;
    this._maxServerStdoutBytes = MAX_STDOUT_BYTES;
    this._maxServerStderrBytes = MAX_STDERR_BYTES;

    this._idleTimeoutMs = options._mockIdleTimeoutMs !== undefined ? options._mockIdleTimeoutMs : IDLE_TIMEOUT_MS;
    this._pollIntervalMs = options._mockPollIntervalMs !== undefined ? options._mockPollIntervalMs : POLL_INTERVAL_MS;
    this._interactionPollMs = options._mockInteractionPollMs !== undefined ? options._mockInteractionPollMs : INTERACTION_POLL_MS;
    this._automationPolicy = null;
    this._hardDeadlineMs = null;
    this._seenInteractionIds = new Set();
    this._asyncResultText = '';
    this._asyncResultUsage = { input: 0, output: 0, total: 0 };
    this._asyncResultCost = null;
    this._asyncBackendSessionId = null;
    // Set once /session/status has actually reported our session, so its later
    // absence from that map can be read as "turn over" rather than "no idea".
    this._sawLiveStatus = false;
    this._promptSentAt = null;
    this._resumeSessionId = null;

    this._serversDir = this._stateRoot ? path.join(this._stateRoot, 'servers') : null;
  }

  get disposed() { return this._disposed; }
  get cancelled() { return this._cancelled; }
  get cancelRungReached() { return this._cancelRungReached; }
  /** @returns {string} */
  get serverStdout() { return this._serverStdout; }
  /** @returns {string} */
  get serverStderr() { return this._serverStderr; }

  _buildArgs(port) {
    return ['serve', '--port', String(port), '--hostname', '127.0.0.1'];
  }

  _parseStartupOutput(text) {
    const match = text.match(/opencode server listening on http:\/\/[^:]+:(\d+)/);
    if (match) return parseInt(match[1], 10);
    return null;
  }

  async _reservePort(maxRetries) {
    const maxAttempts = maxRetries || PORT_RESERVE_MAX_RETRIES;
    const errors = [];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const port = await new Promise((resolve, reject) => {
          const server = net.createServer();
          let settled = false;
          const timer = setTimeout(() => {
            settled = true;
            server.close();
            reject(new Error('Port reservation timed out'));
          }, PORT_RESERVE_TIMEOUT_MS);
          if (timer.unref) timer.unref();

          server.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            server.close(() => reject(err));
          });

          server.listen(0, '127.0.0.1', () => {
            if (settled) return;
            const boundPort = server.address().port;
            clearTimeout(timer);
            server.close(() => {
              resolve(boundPort);
            });
          });
        });
        return port;
      } catch (err) {
        errors.push(err.message);
        if (attempt < maxAttempts - 1) {
          await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        }
      }
    }

    throw new Error(`Port reservation failed after ${maxAttempts} attempts: ${errors.join('; ')}`);
  }

  _generatePassword() {
    return 'dcli_' + crypto.randomBytes(24).toString('hex');
  }

  _registerPasswordWithRedactor() {
    const redactor = getRedactor();
    if (redactor && this._password) {
      redactor.registerSecret('opencode_server_password', this._password);
    }
  }

  _writeServerMetadata(port, executionToken) {
    if (!this._serversDir || !this._jobId) return;
    const meta = {
      pid: this._backendPid,
      creationTime: this._creationTime || new Date().toISOString(),
      imagePath: this._imagePath || '',
      executionToken: executionToken || '',
      port,
      startedAt: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(this._serversDir, { recursive: true });
      const filePath = path.join(this._serversDir, `${this._jobId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    } catch {}
  }

  _deleteServerMetadata() {
    if (!this._serversDir || !this._jobId) return;
    const filePath = path.join(this._serversDir, `${this._jobId}.json`);
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }

  _discoverOrphanedServers() {
    if (!this._serversDir || !fs.existsSync(this._serversDir)) return [];
    const results = [];
    try {
      const entries = fs.readdirSync(this._serversDir);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          const content = fs.readFileSync(path.join(this._serversDir, entry), 'utf8');
          const meta = JSON.parse(content);
          results.push({ jobId: entry.replace('.json', ''), ...meta });
        } catch {}
      }
    } catch {}
    return results;
  }

  _appendServerStdout(chunk) {
    if (typeof chunk === 'string') {
      if (this._serverStdout.length < this._maxServerStdoutBytes) {
        this._serverStdout += chunk;
        if (this._serverStdout.length > this._maxServerStdoutBytes) {
          this._serverStdout = this._serverStdout.slice(0, this._maxServerStdoutBytes);
        }
      }
    }
  }

  _appendServerStderr(chunk) {
    if (typeof chunk === 'string') {
      if (this._serverStderr.length < this._maxServerStderrBytes) {
        this._serverStderr += chunk;
        if (this._serverStderr.length > this._maxServerStderrBytes) {
          this._serverStderr = this._serverStderr.slice(0, this._maxServerStderrBytes);
        }
      }
    }
  }

  _buildPermissionRuleset(access) {
    switch (access) {
      case 'full':
        return [{ permission: '*', pattern: '*', action: 'allow' }];

      case 'workspace':
        return [
          { permission: '*', pattern: '*', action: 'allow' },
          { permission: 'external_directory', pattern: '*', action: 'deny' },
        ];

      case 'read-only':
      default:
        return [
          { permission: 'read', pattern: '*', action: 'allow' },
          { permission: 'glob', pattern: '*', action: 'allow' },
          { permission: 'grep', pattern: '*', action: 'allow' },
          { permission: 'lsp', pattern: '*', action: 'allow' },
          { permission: 'bash', pattern: '*', action: 'allow' },
          { permission: 'task', pattern: '*', action: 'allow' },
          { permission: 'edit', pattern: '*', action: 'deny' },
          { permission: 'todowrite', pattern: '*', action: 'deny' },
          { permission: 'skill', pattern: '*', action: 'deny' },
          { permission: 'external_directory', pattern: '*', action: 'deny' },
          { permission: 'webfetch', pattern: '*', action: 'deny' },
          { permission: 'websearch', pattern: '*', action: 'deny' },
        ];
    }
  }

  _parseModelString(modelStr) {
    if (!modelStr || typeof modelStr !== 'string') {
      return { providerID: 'opencode-go', id: 'deepseek-v4-flash' };
    }
    const firstSlash = modelStr.indexOf('/');
    if (firstSlash === -1) {
      return { providerID: modelStr, id: modelStr };
    }
    return {
      providerID: modelStr.slice(0, firstSlash),
      id: modelStr.slice(firstSlash + 1),
    };
  }

  _buildUrl(endpoint) {
    const base = this._serverBaseUrl || 'http://127.0.0.1:0';
    const url = new URL(endpoint, base);

    if (this._canonicalDir) {
      const needsDir = !ENDPOINTS_WITHOUT_DIR_PREFIXES.some(p => endpoint.startsWith(p));
      if (needsDir) {
        url.searchParams.set('directory', this._canonicalDir);
      }
    }

    return url.toString();
  }

  _transportRequest(method, endpoint, body, timeoutMs) {
    if (this._testMode && typeof this._transportRequestOverride === 'function') {
      return this._transportRequestOverride(method, endpoint, body, timeoutMs);
    }
    if (this._testMode) {
      return { _simulated: true, method, endpoint };
    }
    const url = this._buildUrl(endpoint);
    return httpRequest(method, url, body, timeoutMs, this._password);
  }

  _buildSessionBody(prompt) {
    const model = this._modelObj || { providerID: 'opencode-go', id: 'deepseek-v4-flash' };
    const body = {
      title: 'dcli job',
      model,
      permission: this._lastPermissionRuleset || this._buildPermissionRuleset(this._accessMode || 'read-only'),
    };

    if (this._variant) {
      body.model = { ...body.model, variant: this._variant };
    }

    return body;
  }

  async _verifyProjectIdentity() {
    if (this._testMode) return;
    if (!this._serverBaseUrl || !this._canonicalDir) return;

    const projectUrl = this._buildUrl('/project/current');
    const project = await httpGet(projectUrl, {
      responseTimeout: PROJECT_CHECK_TIMEOUT_MS,
      password: this._password,
    });

    if (!project) {
      throw new Error('Project identity check failed: no response from /project/current');
    }

    const effectiveDir = project.directory || project.path || project.worktree || null;
    if (!effectiveDir) {
      throw new Error('Project identity check failed: /project/current returned no directory');
    }

    const normalizedCanonical = fs.realpathSync.native(path.resolve(this._canonicalDir)).toLowerCase();
    const normalizedEffective = fs.realpathSync.native(path.resolve(effectiveDir)).toLowerCase();

    if (normalizedEffective === normalizedCanonical) return;

    // A git worktree of a project opencode already knows about is not
    // reported as its own project: /project/current keeps returning the
    // original registered project's directory (confusingly, in its own
    // "worktree" field) and instead lists every known worktree path under
    // "sandboxes". Accept the canonical directory if it shows up there.
    const sandboxes = Array.isArray(project.sandboxes) ? project.sandboxes : [];
    for (const sandbox of sandboxes) {
      let normalizedSandbox;
      try {
        normalizedSandbox = fs.realpathSync.native(path.resolve(sandbox)).toLowerCase();
      } catch {
        continue;
      }
      if (normalizedSandbox === normalizedCanonical) return;
    }

    throw new Error(
      `Project identity mismatch: server reports "${effectiveDir}" but canonical job directory is "${this._canonicalDir}". ` +
      'Refusing to send prompt to the wrong repository.'
    );
  }

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
          const classHint = this._classifyBackendError(payload);
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

  /**
   * The error an assistant turn ended on, from `/session/:id/message`.
   *
   * opencode records a failed turn as a normal message carrying `info.error`;
   * there is no separate failure signal to observe, so this is the only place
   * a provider refusal is visible once the SSE stream has closed.
   *
   * @param {*} messageResponse
   * @returns {{ message:string, name:string|null, statusCode:number|null,
   *             class_hint:string }|null}
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
        class_hint: this._classifyBackendError(data) || this._classifyBackendError(err) || 'provider_error',
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
      const parts = msg.parts || [];
      const hasStop = parts.some(p => (p.type === 'step-finish' || p.type === 'step_finish') && p.reason === 'stop');
      if (hasStop) {
        if (msg.info && msg.info.id) {
          lastCompletedMid = msg.info.id;
          hasInfoIds = true;
        } else {
          lastCompletedMid = null;
          const stopPart = parts.find(p => (p.type === 'step-finish' || p.type === 'step_finish') && p.reason === 'stop');
          finalFlatMid = stopPart ? stopPart.messageID || null : null;
        }
      }
    }

    let text = '';
    let usage = { input: 0, output: 0, total: 0 };
    let cost = null;

    if (hasInfoIds) {
      for (const msg of messages) {
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
      const parts = messages.length > 0 ? messages[0].parts || [] : [];
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

    const parts = messages.length > 0 ? messages[0].parts || [] : [];
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

  GetResourceCost() {
    return {
      concurrencySlots: 1,
      memoryEstimateMb: 256,
    };
  }

  GetIdentity() {
    return {
      backend: 'opencode',
      adapter_version: '1.0.0',
      state_schema_version: 1,
    };
  }

  DetectVersion() {
    if (this._testMode) return this._mockVersion || '1.18.8';
    if (this._detectedVersion) return this._detectedVersion;

    const opencodePath = resolveOpencodePath();
    const { execSync } = require('node:child_process');
    try {
      const result = execSync(`"${opencodePath}" --version`, {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      });
      this._detectedVersion = result.toString().trim();
      return this._detectedVersion;
    } catch (err) {
      throw new Error(`Cannot detect opencode version: ${err.message}`);
    }
  }

  ProbeCapabilities() {
    return {
      schema_version: 1,
      backend: 'opencode',
      backend_version: this._detectedVersion || 'unknown',
      core: { run: true, submit: true, resume: true, cancel: true, wrapper_worktree: true },
      extensions: {
        interactive_permissions: { supported: true, transport: 'http' },
        answerable_questions: { supported: true, transport: 'http' },
        graceful_session_abort: { supported: true },
        schema_constrained_output: { supported: false, reason: 'known broken in 1.18.7' },
      },
      supported_version_range: { min: '1.18.0', max: '1.19.0' },
      resource_cost: this.GetResourceCost(),
    };
  }

  DeclareCancelRungs() {
    return ['session_abort', 'server_dispose', 'hard_kill'];
  }

  ValidateRequest(request) {
    if (!request || typeof request !== 'object') return;

    if (request.reasoningEffort !== undefined && request.reasoningEffort !== null) {
      const err = new Error(
        '--reasoning-effort is not supported by backend opencode. ' +
        'Use --variant <provider-specific-value>. ' +
        "Run 'dcli-opencode capabilities --json' for the current surface. " +
        'No job was created.'
      );
      err.code = 'VALIDATION_FAILED';
      err.failureClass = 'unsupported_capability';
      err.optionName = '--reasoning-effort';
      err.backendName = 'opencode';
      throw err;
    }
    if (request.effort !== undefined && request.effort !== null) {
      const err = new Error(
        '--effort is not supported by backend opencode. ' +
        'Use --variant <provider-specific-value>. ' +
        "Run 'dcli-opencode capabilities --json' for the current surface. " +
        'No job was created.'
      );
      err.code = 'VALIDATION_FAILED';
      err.failureClass = 'unsupported_capability';
      err.optionName = '--effort';
      err.backendName = 'opencode';
      throw err;
    }
  }

  PrepareInvocation(attempt, request) {
    if (!request) return;

    if (request.canonicalDir) {
      this._canonicalDir = request.canonicalDir;
    }
    if (request.access) {
      this._accessMode = request.access;
    }
    // Set only for a continue_backend_session resume; see SendPrompt.
    this._resumeSessionId = request.resumeSessionId || null;
    if (!this._accessMode) {
      this._accessMode = 'read-only';
    }

    this._lastPermissionRuleset = this._buildPermissionRuleset(this._accessMode);

    if (request.model) {
      this._modelObj = this._parseModelString(request.model);
    }
    if (request.variant) {
      this._variant = request.variant;
    }
  }

  async Start(attempt) {
    if (this._testMode) {
      this._backendPid = 42;
      if (!this._mockSseEvents && this._mockFacts) {
        this._facts = [...this._mockFacts];
      } else {
        this._facts = [];
      }
      return { handle: 'opencode-test-handle' };
    }

    this._password = this._generatePassword();
    this._registerPasswordWithRedactor();

    const opencodePath = resolveOpencodePath();

    const port = await this._reservePort();
    const args = this._buildArgs(port);

    const invocation = buildCmdInvocation({
      command: opencodePath,
      args,
      cwd: this._canonicalDir || undefined,
    });

    const server = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: this._password },
      windowsHide: invocation.windowsHide,
      // Forward the invocation's own value: it is the single source of truth
      // for how its command line was quoted (docs/tickets/80).
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    this._serverProcess = server;
    this._backendPid = server.pid;
    this._creationTime = new Date().toISOString();
    this._imagePath = opencodePath;
    this._executionToken = crypto.randomBytes(16).toString('hex');

    let startupResolve;
    let startupReject;
    const startupPromise = new Promise((resolve, reject) => {
      startupResolve = resolve;
      startupReject = reject;
    });

    const startupTimer = setTimeout(() => {
      startupReject(new Error('Server startup timed out'));
    }, this._startupTimeoutMs);

    server.stdout.setEncoding('utf8');
    server.stderr.setEncoding('utf8');

    server.stdout.on('data', (chunk) => {
      this._appendServerStdout(chunk);
      const port = this._parseStartupOutput(this._serverStdout);
      if (port !== null) {
        clearTimeout(startupTimer);
        startupResolve(port);
      }
    });

    server.stderr.on('data', (chunk) => {
      this._appendServerStderr(chunk);
    });

    server.on('exit', (code, signal) => {
      if (this._serverPort === null) {
        clearTimeout(startupTimer);
        startupReject(new Error(`Server exited prematurely with code ${code} signal ${signal}`));
      }
    });

    server.on('error', (err) => {
      clearTimeout(startupTimer);
      startupReject(err);
    });

    let resolvedPort;
    try {
      resolvedPort = await startupPromise;
    } catch (err) {
      this._killServer();
      throw err;
    }

    if (resolvedPort !== port) {
      this._killServer();
      throw new Error(`Server bound on port ${resolvedPort} but was launched on port ${port}`);
    }

    this._serverPort = resolvedPort;
    this._serverBaseUrl = `http://127.0.0.1:${resolvedPort}`;

    try {
      const health = await httpGet(`${this._serverBaseUrl}/global/health`, {
        responseTimeout: this._healthTimeoutMs,
        password: this._password,
      });
      if (!health || !health.healthy) {
        throw new Error(`Server health check failed: version=${health ? health.version : 'unknown'}`);
      }
    } catch (err) {
      this._killServer();
      throw err;
    }

    this._writeServerMetadata(resolvedPort, this._executionToken);

    return {
      handle: 'opencode-server',
      serverPid: server.pid,
      port: resolvedPort,
      version: this._detectedVersion || 'unknown',
    };
  }

  async SendPrompt(attempt, prompt) {
    if (this._testMode && this._mockSseEvents) {
      this._sessionId = this._mockSessionId || 'ses_mock';
      this._backendSessionId = this._sessionId;
      return;
    }
    if (this._testMode && this._mockFacts && this._mockFacts.length > 0) {
      return;
    }
    if (this._testMode && typeof this._transportRequestOverride !== 'function') {
      return;
    }

    if (!this._canonicalDir) {
      throw new Error('Cannot send prompt: no canonical job directory set. Call PrepareInvocation first.');
    }

    if (!this._lastPermissionRuleset) {
      this._lastPermissionRuleset = this._buildPermissionRuleset(this._accessMode || 'read-only');
    }

    await this._verifyProjectIdentity();

    // Continuing the parent's session means posting into it, not creating a
    // new one. Creating one regardless is why continue_backend_session used to
    // answer with none of the parent's context while reporting success.
    if (this._resumeSessionId) {
      this._sessionId = this._resumeSessionId;
      this._backendSessionId = this._resumeSessionId;
    } else {
      const sessionBody = this._buildSessionBody(prompt);
      const session = await this._transportRequest('POST', '/session', sessionBody, SESSION_TIMEOUT_MS);
      this._sessionId = session.id;
      this._backendSessionId = session.id;
    }
    const session = { id: this._sessionId };

    const promptBody = {
      parts: [{ type: 'text', text: prompt }],
    };

    const response = await this._transportRequest('POST', `/session/${session.id}/prompt_async`, promptBody, PROMPT_ASYNC_TIMEOUT_MS);
    // The turn is in flight from here, which is what makes a later absence from
    // /session/status meaningful. See _fetchSessionStatus.
    this._promptSentAt = Date.now();
    if (typeof response === 'object' && response !== null && response.statusCode) {
      if (response.statusCode !== 204) {
        throw new Error(`prompt_async returned HTTP ${response.statusCode}, expected 204`);
      }
    }
  }

  async *_runAsyncReconciliation(attempt) {
    this._asyncResultText = '';
    this._asyncResultUsage = { input: 0, output: 0, total: 0 };
    this._asyncResultCost = null;
    this._asyncBackendSessionId = this._sessionId;

    yield { type: 'started', backend_pid: this._backendPid, backend_session_id: this._sessionId };

    const POLL_MS = this._pollIntervalMs;
    const SSE_TIMEOUT = SSE_READ_TIMEOUT_MS;

    let sseLastId = null;
    let idleSince = null;
    let lastPoll = Date.now();
    let lastInteractionPoll = 0;
    let reconnectCount = 0;
    let statusCache = null;

    async function pollNow(self) {
      try {
        statusCache = await self._fetchSessionStatus();
        self._asyncBackendSessionId = self._asyncBackendSessionId || self._sessionId;
        return statusCache;
      } catch {
        return null;
      }
    }

    while (reconnectCount < MAX_SSE_RECONNECTS) {
      if (this._cancelled) break;

      const sseGen = this._sseReadEvents(sseLastId);
      let sseDone = false;

      while (!sseDone) {
        if (this._cancelled) break;

        if (Date.now() - lastPoll >= POLL_MS) {
          lastPoll = Date.now();
          const s = await pollNow(this);
          if (s) yield { type: 'backend_status', state: s };
        }

        if (Date.now() - lastInteractionPoll >= this._interactionPollMs) {
          lastInteractionPoll = Date.now();
          if (this._hardDeadlineMs === null || Date.now() < this._hardDeadlineMs) {
            const interactions = await this._pollInteractions();
            for (const interaction of interactions) {
              yield { type: 'interaction_pending', interaction_id: interaction.interaction_id, kind: interaction.kind, detail: interaction.detail };
              if (!this._automationPolicy) {
                try {
                  await this._rejectInteraction(interaction);
                } catch (err) {
                  if (err && err.rejectFailed) {
                    yield { type: 'stream_closed', reason: 'interaction_reject_failed', detail: { interaction_id: interaction.interaction_id, error: err.message } };
                    break;
                  }
                  throw err;
                }
                yield { type: 'interaction_resolved', interaction_id: interaction.interaction_id, outcome: 'rejected_unattended' };
                const permPayload = interaction.raw ? { permission: interaction.raw.permission || null, patterns: interaction.raw.patterns || null } : {};
                yield {
                  type: 'backend_error',
                  class_hint: 'permission_or_sandbox',
                  structured_payload: { ...permPayload, message: 'Interaction rejected: no authorized responder available' },
                };
              }
            }
          }
        }

        if (statusCache === 'idle') {
          if (idleSince === null) {
            idleSince = Date.now();
          } else if (Date.now() - idleSince > IDLE_CONFIRM_MS) {
            sseDone = true;
            break;
          }
        } else {
          idleSince = null;
        }

        const nextResult = await this._readSseWithTimeout(sseGen, SSE_TIMEOUT);

        if (nextResult === null) continue;

        if (nextResult.done) {
          yield { type: 'stream_closed', reason: 'sse_disconnect' };
          sseDone = true;
          break;
        }

        const event = nextResult.value;
        const sseId = event._sseId || null;
        if (sseId) sseLastId = sseId;

        const events = Array.isArray(event) ? event : [event];
        const facts = this._processSseEvents(events);
        for (const f of facts) yield f;
        idleSince = null;
      }

      if (this._cancelled) break;

      reconnectCount++;

      if (statusCache === null || statusCache === 'idle') {
        break;
      }

      if (reconnectCount >= MAX_SSE_RECONNECTS) {
        break;
      }

      try {
        const gapMsgs = await this._readMessagesFromServer();
        if (gapMsgs) {
          const gf = this._processMessageFacts(gapMsgs);
          for (const f of gf) yield f;
        }
      } catch {}
    }

    if (!this._cancelled) {
      try {
        const msgs = await this._readMessagesFromServer();
        const final = this._selectFinalMessage(msgs);
        this._asyncResultText = final.text;
        this._asyncResultUsage = final.usage;
        this._asyncResultCost = final.cost;
        // An assistant turn that failed carries its error on the message, and
        // nothing here used to read it — so a provider refusal surfaced as a
        // successful job with an empty result. Emit it as a fact and let the
        // engine decide the state.
        const msgError = this._findMessageError(msgs);
        if (msgError) {
          yield {
            type: 'backend_error',
            class_hint: msgError.class_hint,
            structured_payload: { message: msgError.message, name: msgError.name, status_code: msgError.statusCode },
          };
        }
        if (final.text) {
          yield { type: 'assistant_text', message_id: final.message_id || this._sessionId || 'msg_final', text: final.text };
        }
        yield {
          type: 'usage_reported',
          tokens: final.usage,
          cost: final.cost,
        };
      } catch (err) {
        yield { type: 'stream_closed', reason: 'finalization_error' };
      }
    }

    yield { type: 'process_exited', code: 0 };
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

  async _fetchSessionStatus() {
    if (this._testMode && this._mockSessionStatusResponses) {
      if (this._mockStatusIndex === undefined) this._mockStatusIndex = 0;
      if (this._mockStatusIndex < this._mockSessionStatusResponses.length) {
        const resp = this._mockSessionStatusResponses[this._mockStatusIndex++];
        const sid = this._mockSessionId || this._sessionId;
        if (resp && resp[sid] && resp[sid].type) {
          const t = resp[sid].type;
          return t === 'retry' ? 'retrying' : t;
        }
        return 'unknown';
      }
      return 'unknown';
    }

    const status = await this._transportRequest('GET', '/session/status', null, SESSION_STATUS_TIMEOUT_MS);
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
      // terminates only on a confirmed 'idle' — never terminated: a model turn
      // that ended in an APIError (verified live: a 403 RegionError, five
      // seconds in) was polled for the full hard-timeout budget and reported as
      // `timed_out` with zero bytes, hiding the real error behind a fake stall.
      //
      // Guarded so a session that has not yet been registered is not read as
      // finished. Observing it live once is the strong signal, but it cannot be
      // the only one: a turn that fails in the first few seconds — the case
      // this exists for — can be gone before the first poll ever sees it. So a
      // registration grace period counted from the prompt also qualifies.
      if (this._sawLiveStatus) return 'idle';
      if (this._promptSentAt && Date.now() - this._promptSentAt > SESSION_REGISTRATION_GRACE_MS) {
        return 'idle';
      }
    }
    return 'unknown';
  }

  async _readMessagesFromServer() {
    if (this._testMode && this._mockMessagesResponse) {
      return this._mockMessagesResponse;
    }

    return this._transportRequest('GET', `/session/${this._sessionId}/message`, null, MESSAGES_TIMEOUT_MS);
  }

  async _pollInteractions() {
    const results = [];
    try {
      const perms = await this._transportRequest('GET', '/permission', null, 5000);
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
      const questions = await this._transportRequest('GET', '/question', null, 5000);
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
        await this._transportRequest('POST', `/question/${interaction.interaction_id}/reject`, {}, 5000);
      } else {
        await this._transportRequest('POST', `/permission/${interaction.interaction_id}/reply`, {
          reply: 'reject',
          message: 'Automatically rejected: no authorized responder is available to answer this permission request. Provide an automation policy or run interactively.',
        }, 5000);
      }
    } catch (err) {
      if (err && err.statusCode === 404) return;
      const wrapped = new Error(`Failed to reject interaction ${interaction.interaction_id}: ${err.message}`);
      wrapped.rejectFailed = true;
      wrapped.cause = err;
      throw wrapped;
    }
  }

  _classifyBackendError(structuredPayload) {
    if (!structuredPayload || typeof structuredPayload !== 'object') return null;
    const responseBody = structuredPayload.responseBody || structuredPayload.body || null;
    if (responseBody && typeof responseBody === 'object') {
      const errorType = responseBody.error && responseBody.error.type;
      if (errorType === 'CreditsError') return 'quota_or_rate_limit';
    }
    if (structuredPayload.name === 'CreditsError') return 'quota_or_rate_limit';
    return null;
  }

  async *_sseReadEvents(lastEventId) {
    if (this._testMode && this._mockSseEvents) {
      const events = this._mockSseEvents;
      this._mockSseEvents = [];
      for (const ev of events) {
        if (this._cancelled) return;
        yield ev;
      }
      return;
    }

    const url = this._buildUrl('/event');
    const u = new URL(url);

    const headers = {};
    if (this._password) {
      headers['Authorization'] = 'Basic ' + Buffer.from('opencode:' + this._password).toString('base64');
    }
    if (lastEventId) {
      headers['Last-Event-ID'] = lastEventId;
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

  async *Observe(attempt) {
    if (this._testMode && this._mockSseEvents) {
      yield* this._runAsyncReconciliation(attempt);
      return;
    }
    if (this._testMode && this._mockFacts) {
      for (const fact of this._mockFacts) {
        yield { ...fact };
      }
      return;
    }
    yield* this._runAsyncReconciliation(attempt);
  }

  Resume(attempt, kind, prompt) {
  }

  async Respond(interactionId, decision) {
    const kind = (typeof decision === 'object' && decision !== null) ? (decision.kind || 'permission') : 'permission';
    const reply = (typeof decision === 'object' && decision !== null) ? (decision.reply || 'reject') : (decision === 'allow' ? 'once' : 'reject');
    const message = (typeof decision === 'object' && decision !== null) ? decision.message : undefined;

    if (reply === 'always' && !this._automationPolicy) {
      const err = new Error(
        'reply: always requires an explicitly supplied automation policy. ' +
        'Pass --automation-policy to the job to enable persistent grants.'
      );
      err.code = 'VALIDATION_FAILED';
      throw err;
    }

    const endpoint = kind === 'question'
      ? `/question/${interactionId}/reply`
      : `/permission/${interactionId}/reply`;

    const body = kind === 'question'
      ? { answers: (typeof decision === 'object' && decision !== null && Array.isArray(decision.answers)) ? decision.answers : [] }
      : { reply, ...(message ? { message } : {}) };

    if (this._testMode) {
      if (typeof this._transportRequestOverride === 'function') {
        return this._transportRequestOverride('POST', endpoint, body, 5000);
      }
      return { simulated: true };
    }

    try {
      return await this._transportRequest('POST', endpoint, body, 5000);
    } catch (err) {
      if (err && err.statusCode === 404) return { resolved: true };
      throw err;
    }
  }

  async RequestCancel(attempt, rung) {
    if (this._cancelled) return { success: true };

    switch (rung) {
      case 'session_abort':
        if (this._sessionId && this._serverBaseUrl) {
          try {
            const abortUrl = this._buildUrl(`/session/${this._sessionId}/abort`);
            await httpPost(abortUrl, {}, { responseTimeout: 5000, password: this._password });
            this._cancelRungReached = 'session_abort';
            this._cancelled = true;
            return { success: true };
          } catch {
            return { success: false, error: 'session_abort HTTP failed' };
          }
        }
        this._cancelRungReached = 'session_abort';
        this._cancelled = true;
        return { success: true };

      case 'server_dispose':
        if (this._serverBaseUrl) {
          try {
            await httpPost(`${this._serverBaseUrl}/global/dispose`, {}, { responseTimeout: DISPOSE_TIMEOUT_MS, password: this._password });
          } catch {
            return { success: false, error: 'server_dispose HTTP failed' };
          }
        }
        this._killServer();
        this._serverBaseUrl = null;
        this._cancelRungReached = 'server_dispose';
        this._cancelled = true;
        return { success: true };

      case 'hard_kill':
        this._killServer();
        this._cancelRungReached = 'hard_kill';
        this._cancelled = true;
        return { success: true };

      default:
        return { success: false, error: `Unknown rung: ${rung}` };
    }
  }

  _killServer() {
    if (this._serverProcess) {
      try { this._serverProcess.kill('SIGKILL'); } catch {
        try { this._serverProcess.kill(); } catch {}
      }
    }
  }

  CollectResult(attempt) {
    if (this._collectedResult) return this._collectedResult;

    let lastText = '';
    let usage = { input: 0, output: 0, total: 0 };
    let backendSessionId = null;

    if (this._mockSseEvents || (!this._testMode && this._asyncResultText !== undefined)) {
      lastText = this._asyncResultText || '';
      usage = this._asyncResultUsage || { input: 0, output: 0, total: 0 };
      backendSessionId = this._asyncBackendSessionId || this._sessionId || null;
    } else {
      const facts = this._testMode ? (this._mockFacts || []) : this._facts;
      for (const f of facts) {
        if (f.type === 'assistant_text') lastText = f.text;
        if (f.type === 'usage_reported' && f.tokens) usage = { ...f.tokens };
        if (f.type === 'started' && f.backend_session_id) backendSessionId = f.backend_session_id;
      }
    }

    const result = { text: lastText, usage, backend_session_id: backendSessionId };
    this._collectedResult = result;
    return result;
  }

  CollectDiagnostics(attempt) {
    const factCount = this._mockFacts ? this._mockFacts.length : (this._facts ? this._facts.length : 0);
    return {
      schema_version: 1,
      backend: 'opencode',
      version: this._detectedVersion || 'unknown',
      facts_emitted: factCount,
      exit_code: this._resolveExitCode(),
      interactions_seen: this._seenInteractionIds.size,
      has_automation_policy: this._automationPolicy !== null,
    };
  }

  _resolveExitCode() {
    if (this._mockExitCode !== null) return this._mockExitCode;
    const facts = this._facts || [];
    for (let i = facts.length - 1; i >= 0; i--) {
      if (facts[i].type === 'process_exited') {
        return facts[i].code !== undefined ? facts[i].code : null;
      }
    }
    return null;
  }

  Dispose(attempt) {
    if (this._disposed) return;
    this._disposed = true;

    if (!this._testMode) {
      if (this._serverBaseUrl) {
        try { httpPost(`${this._serverBaseUrl}/global/dispose`, {}, { responseTimeout: DISPOSE_TIMEOUT_MS, password: this._password }).catch(() => {}); } catch {}
      }
      this._killServer();
    }

    this._deleteServerMetadata();

    this._serverProcess = null;
    this._serverBaseUrl = null;
    this._serverPort = null;
  }

  Recover(attempt) {
    if (this._cancelled) return { state: 'cancelled' };
    const facts = this._mockFacts || this._facts || [];
    const processExited = facts.find(f => f && f.type === 'process_exited');
    if (processExited) {
      return { state: processExited.code === 0 ? 'done' : 'failed' };
    }
    const backendError = facts.find(f => f && f.type === 'backend_error');
    if (backendError) return { state: 'failed' };
    return { state: 'interrupted' };
  }

  async _probeEndpointShape(url, method, body, timeoutMs, name, shapeCheck) {
    try {
      const hdrs = {};
      if (this._password) {
        hdrs['Authorization'] = 'Basic ' + Buffer.from('opencode:' + this._password).toString('base64');
      }
      const u = new URL(url);
      const result = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: u.hostname, port: u.port, path: u.pathname + u.search,
          method: method || 'GET', headers: hdrs, timeout: timeoutMs || 5000,
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed = null;
            try { parsed = JSON.parse(raw); } catch {}
            resolve({ statusCode: res.statusCode, body: raw, parsed });
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
      return shapeCheck(result);
    } catch (err) {
      return { name, ok: false, detail: err.message };
    }
  }

  async _runEndpointShapeProbes(baseUrl) {
    const results = [];
    results.push(await this._probeEndpointShape(
      `${baseUrl}/global/health`, 'GET', null, 5000, 'health_endpoint',
      (r) => {
        const p = r.parsed;
        if (!p || typeof p !== 'object') return { name: 'health_endpoint', ok: false, detail: 'response not JSON' };
        if (typeof p.healthy !== 'boolean') return { name: 'health_endpoint', ok: false, detail: 'missing boolean "healthy"' };
        if (typeof p.version !== 'string') return { name: 'health_endpoint', ok: false, detail: 'missing string "version"' };
        return { name: 'health_endpoint', ok: true, detail: `/global/health: healthy=${p.healthy}, version=${p.version}` };
      }
    ));
    if (!this._testMode) {
      results.push(await this._probeEndpointShape(
        `${baseUrl}/permission`, 'GET', null, 5000, 'permission_endpoint',
        (r) => {
          if (r.statusCode >= 200 && r.statusCode < 300) {
            return { name: 'permission_endpoint', ok: true, detail: `/permission returns ${Array.isArray(r.parsed) ? 'array' : typeof r.parsed}` };
          }
          return { name: 'permission_endpoint', ok: false, detail: `HTTP ${r.statusCode}` };
        }
      ));
      results.push(await this._probeEndpointShape(
        `${baseUrl}/question`, 'GET', null, 5000, 'question_endpoint',
        (r) => {
          if (r.statusCode >= 200 && r.statusCode < 300) {
            return { name: 'question_endpoint', ok: true, detail: `/question returns ${Array.isArray(r.parsed) ? 'array' : typeof r.parsed}` };
          }
          return { name: 'question_endpoint', ok: false, detail: `HTTP ${r.statusCode}` };
        }
      ));
      results.push(await this._probeEndpointShape(
        `${baseUrl}/session/status`, 'GET', null, 5000, 'session_status_endpoint',
        (r) => {
          if (r.statusCode >= 200 && r.statusCode < 300) {
            return { name: 'session_status_endpoint', ok: true, detail: `/session/status responds HTTP ${r.statusCode}` };
          }
          return { name: 'session_status_endpoint', ok: false, detail: `HTTP ${r.statusCode}` };
        }
      ));
    }
    return results;
  }

  async LiveSmoke(timeoutMs) {
    if (this._testMode) return;
    const opencodePath = resolveOpencodePath();
    if (!opencodePath) {
      throw new Error('opencode executable not found');
    }
    const { execSync } = require('node:child_process');
    try {
      const result = execSync(`"${opencodePath}" --version`, { encoding: 'utf8', timeout: 10000, windowsHide: true });
      const version = result.toString().trim();
      if (!version) throw new Error('No version output');
    } catch (err) {
      throw new Error(`opencode not available: ${err.message}`);
    }
  }
}

module.exports = { OpencodeAdapter, httpRequest };
