const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
const { getRedactor } = require('../../core/fs-text');

const PORT_RESERVE_MAX_RETRIES = 5;
const PORT_RESERVE_TIMEOUT_MS = 5000;
const STARTUP_TIMEOUT_MS = 30000;
const HEALTH_TIMEOUT_MS = 10000;
const SESSION_TIMEOUT_MS = 10000;
const MESSAGE_TIMEOUT_MS = 600000;
const DISPOSE_TIMEOUT_MS = 5000;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_BYTES = 10 * 1024 * 1024;

function httpRequest(method, url, body, timeoutMs, password) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const effectiveTimeout = timeoutMs || 10000;
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    if (password) {
      headers['Authorization'] = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
    }
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers,
      timeout: effectiveTimeout,
    };

    let settled = false;
    function settle(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(wallClock);
      if (err) reject(err);
      else resolve(result);
    }

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            settle(null, JSON.parse(raw));
          } catch {
            settle(null, raw);
          }
        } else {
          const err = new Error(`HTTP ${res.statusCode} from ${method} ${url}: ${raw.slice(0, 500)}`);
          err.statusCode = res.statusCode;
          err.body = raw;
          settle(err);
        }
      });
    });

    req.on('error', (err) => settle(err));
    req.on('timeout', () => {
      req.destroy();
      settle(new Error(`Request timed out after ${effectiveTimeout}ms: ${method} ${url}`));
    });

    const wallClock = setTimeout(() => {
      req.destroy();
      settle(new Error(`Request wall-clock timeout after ${effectiveTimeout + 5000}ms: ${method} ${url}`));
    }, effectiveTimeout + 5000);
    if (wallClock.unref) wallClock.unref();

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function httpGet(url, opts = {}) {
  return httpRequest('GET', url, null, opts.responseTimeout, opts.password);
}

function httpPost(url, body, opts = {}) {
  return httpRequest('POST', url, body, opts.responseTimeout, opts.password);
}

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
    this._mockFacts = options._mockFacts || [];
    this._mockExitCode = options._mockExitCode !== undefined ? options._mockExitCode : null;
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

    this._startupTimeoutMs = STARTUP_TIMEOUT_MS;
    this._healthTimeoutMs = HEALTH_TIMEOUT_MS;
    this._maxServerStdoutBytes = MAX_STDOUT_BYTES;
    this._maxServerStderrBytes = MAX_STDERR_BYTES;

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
      core: { run: true, submit: true, resume: false, cancel: true, wrapper_worktree: true },
      extensions: {
        interactive_permissions: { supported: false, reason: 'not implemented in thin slice; see tickets 18/20' },
        answerable_questions: { supported: false, reason: 'not implemented in thin slice; see tickets 18/20' },
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
  }

  async Start(attempt) {
    if (this._testMode) {
      this._backendPid = 42;
      this._facts = [...this._mockFacts];
      return { handle: 'opencode-test-handle' };
    }

    this._password = this._generatePassword();
    this._registerPasswordWithRedactor();

    const opencodePath = resolveOpencodePath();

    const port = await this._reservePort();
    const args = this._buildArgs(port);

    const server = spawn(opencodePath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: this._password },
      windowsHide: true,
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
    if (this._testMode) return;

    const sessionBody = {
      title: 'dcli job',
      model: {
        providerID: 'opencode-go',
        id: 'deepseek-v4-flash',
      },
      permission: [{ permission: '*', pattern: '*', action: 'allow' }],
    };

    const session = await httpPost(`${this._serverBaseUrl}/session`, sessionBody, { responseTimeout: SESSION_TIMEOUT_MS, password: this._password });
    this._sessionId = session.id;
    this._backendSessionId = session.id;

    const messageBody = {
      parts: [{ type: 'text', text: prompt }],
    };

    const response = await httpPost(
      `${this._serverBaseUrl}/session/${session.id}/message`,
      messageBody,
      { responseTimeout: MESSAGE_TIMEOUT_MS, password: this._password }
    );

    this._facts = [];
    this._facts.push({ type: 'started', backend_pid: this._backendPid, backend_session_id: session.id });

    if (response && response.parts) {
      let fullText = '';
      let usage = null;

      for (const part of response.parts) {
        if (part.type === 'text') {
          fullText += part.text || '';
        }
        if (part.type === 'step-finish' && part.tokens) {
          usage = part.tokens;
        }
      }

      if (fullText) {
        this._facts.push({ type: 'assistant_text', message_id: `msg_${session.id}`, text: fullText });
      }

      if (usage) {
        this._facts.push({
          type: 'usage_reported',
          tokens: {
            input: usage.input || 0,
            output: usage.output || 0,
            total: usage.total || 0,
          },
          cost: response.cost || null,
        });
      }
    }

    this._facts.push({ type: 'process_exited', code: 0 });
  }

  async *Observe(attempt) {
    for (const fact of this._facts) {
      yield { ...fact };
    }
  }

  Resume(attempt, kind, prompt) {
  }

  Respond(interactionId, decision) {
    throw new Error(
      'Respond is not supported by backend opencode. ' +
      'Interactive permissions are not implemented in this version. ' +
      'No job was created.'
    );
  }

  RequestCancel(attempt, rung) {
    if (this._cancelled) return { success: true };

    switch (rung) {
      case 'session_abort':
        if (this._sessionId && this._serverBaseUrl) {
          try {
            httpPost(`${this._serverBaseUrl}/session/${this._sessionId}/abort`, {}, { responseTimeout: 5000, password: this._password });
          } catch {}
        }
        this._cancelRungReached = 'session_abort';
        this._cancelled = true;
        return { success: true };

      case 'server_dispose':
        if (this._serverBaseUrl) {
          try {
            httpPost(`${this._serverBaseUrl}/global/dispose`, {}, { responseTimeout: DISPOSE_TIMEOUT_MS, password: this._password });
          } catch {}
        }
        this._killServer();
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

    const facts = this._testMode ? this._mockFacts : this._facts;
    for (const f of facts) {
      if (f.type === 'assistant_text') lastText = f.text;
      if (f.type === 'usage_reported' && f.tokens) usage = { ...f.tokens };
      if (f.type === 'started' && f.backend_session_id) backendSessionId = f.backend_session_id;
    }

    const result = { text: lastText, usage, backend_session_id: backendSessionId };
    this._collectedResult = result;
    return result;
  }

  CollectDiagnostics(attempt) {
    return {
      schema_version: 1,
      backend: 'opencode',
      version: this._detectedVersion || 'unknown',
      facts_emitted: this._facts.length,
      exit_code: this._mockExitCode !== null ? this._mockExitCode : 0,
    };
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
    return { state: this._cancelled ? 'cancelled' : (this._mockExitCode !== 0 ? 'failed' : 'done') };
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

module.exports = { OpencodeAdapter };
