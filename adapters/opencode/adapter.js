const { spawn } = require('node:child_process');
const http = require('node:http');

const STARTUP_TIMEOUT_MS = 30000;
const HEALTH_TIMEOUT_MS = 10000;
const SESSION_TIMEOUT_MS = 10000;
const MESSAGE_TIMEOUT_MS = 600000;
const DISPOSE_TIMEOUT_MS = 5000;

function httpRequest(method, url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      timeout: timeoutMs || 10000,
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(raw);
          }
        } else {
          const err = new Error(`HTTP ${res.statusCode} from ${method} ${url}: ${raw.slice(0, 500)}`);
          err.statusCode = res.statusCode;
          err.body = raw;
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timed out after ${timeoutMs || 10000}ms: ${method} ${url}`)); });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function httpGet(url, opts = {}) {
  return httpRequest('GET', url, null, opts.responseTimeout);
}

function httpPost(url, body, opts = {}) {
  return httpRequest('POST', url, body, opts.responseTimeout);
}

function generatePassword() {
  const crypto = require('node:crypto');
  return 'dcli_' + crypto.randomBytes(24).toString('hex');
}

function resolveOpencodePath() {
  if (process.env.OPENCODE_PATH) return process.env.OPENCODE_PATH;

  const knownPaths = [
    'C:\\Users\\lenticetsai\\.bun\\bin\\opencode.exe',
  ];

  for (const p of knownPaths) {
    try {
      if (require('fs').existsSync(p)) return p;
    } catch {}
  }

  const { execSync } = require('node:child_process');
  try {
    const result = execSync('where opencode 2>nul || which opencode 2>/dev/null', {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const line = result.trim().split('\n')[0].trim();
    if (line) return line;
  } catch {}

  return 'opencode';
}

class OpencodeAdapter {
  constructor(options = {}) {
    this._testMode = options._testMode || false;
    this._mockVersion = options._mockVersion || null;
    this._mockFacts = options._mockFacts || [];
    this._mockExitCode = options._mockExitCode !== undefined ? options._mockExitCode : null;

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
    this._stdoutContent = '';
    this._stderrContent = '';
    this._serverHandle = null;
  }

  get disposed() { return this._disposed; }
  get cancelled() { return this._cancelled; }
  get cancelRungReached() { return this._cancelRungReached; }

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

    this._password = generatePassword();
    const opencodePath = resolveOpencodePath();

    const server = spawn(opencodePath, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: this._password },
      windowsHide: true,
    });

    this._serverProcess = server;
    this._backendPid = server.pid;

    let startupResolve;
    let startupReject;
    const startupPromise = new Promise((resolve, reject) => {
      startupResolve = resolve;
      startupReject = reject;
    });

    const startupTimer = setTimeout(() => {
      startupReject(new Error('Server startup timed out'));
    }, STARTUP_TIMEOUT_MS);

    server.stdout.setEncoding('utf8');
    server.stderr.setEncoding('utf8');

    server.stdout.on('data', (chunk) => {
      this._stdoutContent += chunk;
      const match = this._stdoutContent.match(/opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(startupTimer);
        startupResolve(parseInt(match[1], 10));
      }
    });

    server.stderr.on('data', (chunk) => {
      this._stderrContent += chunk;
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

    const port = await startupPromise;
    this._serverPort = port;
    this._serverBaseUrl = `http://127.0.0.1:${port}`;

    const health = await httpGet(`${this._serverBaseUrl}/global/health`, { responseTimeout: HEALTH_TIMEOUT_MS });
    if (!health || !health.healthy) {
      throw new Error(`Server health check failed: version=${health ? health.version : 'unknown'}`);
    }

    return { handle: 'opencode-server', serverPid: server.pid, port, version: health.version };
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

    const session = await httpPost(`${this._serverBaseUrl}/session`, sessionBody, { responseTimeout: SESSION_TIMEOUT_MS });
    this._sessionId = session.id;
    this._backendSessionId = session.id;

    const messageBody = {
      parts: [{ type: 'text', text: prompt }],
    };

    const response = await httpPost(
      `${this._serverBaseUrl}/session/${session.id}/message`,
      messageBody,
      { responseTimeout: MESSAGE_TIMEOUT_MS }
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
            httpPost(`${this._serverBaseUrl}/session/${this._sessionId}/abort`, {}, { responseTimeout: 5000 });
          } catch {}
        }
        this._cancelRungReached = 'session_abort';
        this._cancelled = true;
        return { success: true };

      case 'server_dispose':
        if (this._serverBaseUrl) {
          try {
            httpPost(`${this._serverBaseUrl}/global/dispose`, {}, { responseTimeout: DISPOSE_TIMEOUT_MS });
          } catch {}
        }
        if (this._serverProcess) {
          try { this._serverProcess.kill(); } catch {}
        }
        this._cancelRungReached = 'server_dispose';
        this._cancelled = true;
        return { success: true };

      case 'hard_kill':
        if (this._serverProcess) {
          try { this._serverProcess.kill('SIGKILL'); } catch {
            try { this._serverProcess.kill(); } catch {}
          }
        }
        this._cancelRungReached = 'hard_kill';
        this._cancelled = true;
        return { success: true };

      default:
        return { success: false, error: `Unknown rung: ${rung}` };
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
        try { httpPost(`${this._serverBaseUrl}/global/dispose`, {}, { responseTimeout: DISPOSE_TIMEOUT_MS }).catch(() => {}); } catch {}
      }
      if (this._serverProcess) {
        try { this._serverProcess.kill(); } catch {}
      }
    }

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
