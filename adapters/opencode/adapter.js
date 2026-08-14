const path = require('node:path');
const fs = require('node:fs');
const { executableNames, resolveExecutablePath } = require('../shared/resolve-executable');
const { runProbe } = require('../shared/run-probe');
const { runAdapterSmoke } = require('../../core/adapter-smoke');
const { HttpTransport, requestJson } = require('./transport');
const { OpencodeServer } = require('./server');
const { OpencodeTurn } = require('./turn');
const { containmentRecordForThisSpawn } = require('../shared/process-lifecycle');

const SESSION_TIMEOUT_MS = 10000;
const PROJECT_CHECK_TIMEOUT_MS = 10000;
const DISPOSE_TIMEOUT_MS = 5000;
const PROMPT_ASYNC_TIMEOUT_MS = 15000;

const ENDPOINTS_WITHOUT_DIR_PREFIXES = [
  '/global/', '/instance/', '/event', '/doc',
  '/agent', '/skill', '/command', '/lsp',
  '/provider',
];

function resolvePastBunShim(shimPath) {
  const normalized = path.resolve(shimPath).replace(/\\/g, '/').toLowerCase();
  const bunInstall = process.env.BUN_INSTALL
    ? path.resolve(process.env.BUN_INSTALL).replace(/\\/g, '/').toLowerCase()
    : null;
  const isBunShim = normalized.includes('/.bun/bin/opencode')
    || (bunInstall && normalized.startsWith(`${bunInstall}/bin/opencode`));
  if (!isBunShim) return null;

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
    const result = runProbe('bun', ['pm', 'bin', '-g'], 5000);
    const binDir = result.trim().split('\n')[0].trim();
    if (binDir) {
      const prefix = path.dirname(binDir);
      const fromBun = checkBunPrefix(prefix);
      if (fromBun) return fromBun;
    }
  } catch {}

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
  return resolveExecutablePath({
    envName: 'OPENCODE_PATH',
    fallback: 'opencode',
    names: executableNames('opencode'),
    resolveNear: resolvePastBunShim,
  });
}

/**
 * The opencode adapter, on the ticket-100 seams.
 *
 * HTTP and SSE arrive through an injected `transport` (production: the
 * per-job server's HttpTransport; tests: an in-memory fake). The server
 * module owns the `opencode serve` process; the turn module owns the
 * reconciliation logic. This class maps the wrapper request in and the
 * normalized fact stream out (design-spec §9) — nothing here declares a job
 * finished (invariant 2).
 */
class OpencodeAdapter {
  /**
   * @param {{ transport?: object, stateRoot?: string|null,
   *           jobId?: string|null }} options
   *   `transport` supplied means the caller owns the HTTP/SSE surface and no
   *   server is started — the honest test seam of ticket 100.
   */
  constructor(options = {}) {
    this._transport = options.transport || null;
    this._stateRoot = options.stateRoot || null;
    this._jobId = options.jobId || null;

    this._server = null;
    this._sessionId = null;
    this._backendPid = null;
    this._backendSessionId = null;
    this._containment = undefined;
    this._detectedVersion = null;
    this._disposed = false;
    this._cancelled = false;
    this._cancelRungReached = null;
    this._lastPrompt = null;

    this._canonicalDir = null;
    this._accessMode = null;
    this._lastPermissionRuleset = null;
    this._modelObj = null;
    this._variant = null;

    this._hardDeadlineMs = null;
    this._resumeSessionId = null;
    this._promptSentAt = null;

    this._turn = null;
    this._collectedResult = null;
  }

  get disposed() { return this._disposed; }
  get cancelled() { return this._cancelled; }
  get cancelRungReached() { return this._cancelRungReached; }

  // -------------------------------------------------------------------------
  // URL / request building
  // -------------------------------------------------------------------------

  /**
   * The request path (with the canonical directory query parameter) for an
   * opencode endpoint. The directory footgun (backend-pitfalls.md) is settled
   * here: one canonical job directory on every request that accepts it.
   *
   * @param {string} endpoint
   * @returns {string} path + query, e.g. "/session/status?directory=C%3A%5Crepo"
   */
  _buildPath(endpoint) {
    const u = new URL(endpoint, 'http://localhost');
    if (this._canonicalDir) {
      const needsDir = !ENDPOINTS_WITHOUT_DIR_PREFIXES.some(p => endpoint.startsWith(p));
      if (needsDir) {
        u.searchParams.set('directory', this._canonicalDir);
      }
    }
    return u.pathname + u.search;
  }

  _request({ method, path: endpoint, body, timeoutMs }) {
    if (!this._transport) {
      throw new Error('No transport available: call Start() first or supply a transport to the constructor');
    }
    return requestJson(this._transport, { method, path: endpoint, body, timeoutMs });
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

  // -------------------------------------------------------------------------
  // Capabilities / identity / validation
  // -------------------------------------------------------------------------

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
    if (this._detectedVersion) return this._detectedVersion;

    const opencodePath = resolveOpencodePath();
    const packagePath = path.resolve(path.dirname(opencodePath), '..', 'package.json');
    try {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      if (typeof packageJson.version === 'string' && packageJson.version) {
        this._detectedVersion = packageJson.version;
        return this._detectedVersion;
      }
    } catch {}

    try {
      const result = runProbe(opencodePath, ['--version'], 10000);
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

  // -------------------------------------------------------------------------
  // Invocation
  // -------------------------------------------------------------------------

  _buildPermissionRuleset(access) {
    switch (access) {
      case 'workspace':
        return [
          { permission: '*', pattern: '*', action: 'allow' },
          { permission: 'external_directory', pattern: '*', action: 'deny' },
        ];

      case 'read-only':
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

      default:
        // An out-of-contract value must never be silently granted a ruleset.
        throw new Error(`Unknown access mode "${access}": must be "read-only" or "workspace"`);
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

  async _verifyProjectIdentity() {
    if (!this._transport || !this._canonicalDir) return;

    const project = await this._request({
      method: 'GET',
      path: this._buildPath('/project/current'),
      timeoutMs: PROJECT_CHECK_TIMEOUT_MS,
    });

    if (!project) {
      throw new Error('Project identity check failed: no response from /project/current');
    }

    const effectiveDir = project.directory || project.path || project.worktree || null;
    if (!effectiveDir) {
      throw new Error('Project identity check failed: /project/current returned no directory');
    }

    // opencode reports "/" when launched from a directory it does not
    // recognise as a project (e.g. a non-git temp directory). Accept it when
    // the canonical directory lacks a .git directory — a repo that returns
    // root is a real mismatch.
    if (effectiveDir === '/' || effectiveDir === '\\') {
      const hasGit = fs.existsSync(path.join(this._canonicalDir, '.git'));
      if (!hasGit) return;
    }
    const normalizedCanonical = fs.realpathSync.native(path.resolve(this._canonicalDir)).toLowerCase();
    let normalizedEffective = null;
    try {
      const resolved = fs.realpathSync.native(path.resolve(effectiveDir));
      if ((resolved === '\\' || resolved === '/') && !fs.existsSync(path.join(this._canonicalDir, '.git'))) {
        return;
      }
      normalizedEffective = resolved.toLowerCase();
    } catch {
      // OpenCode can report a stale original project path while the actual
      // job directory is listed under sandboxes. Check that list below before
      // turning the stale path into a backend failure.
    }

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

  async Start(attempt) {
    if (this._transport) {
      // The caller supplied the HTTP/SSE surface (the ticket-100 test seam);
      // there is no server to launch.
      this._backendPid = this._transport.pid != null ? this._transport.pid : null;
      return {
        handle: 'opencode-transport',
        serverPid: this._backendPid,
        port: null,
        version: this._detectedVersion || 'unknown',
      };
    }

    const server = new OpencodeServer({ stateRoot: this._stateRoot, jobId: this._jobId });
    const opencodePath = resolveOpencodePath();
    const handle = await server.start({ canonicalDir: this._canonicalDir, opencodePath });

    this._server = server;
    this._transport = server.transport;
    this._backendPid = server.pid;
    // The server was actually spawned (the transport seam above is a test
    // stub that spawns nothing), so this spawn's containment record applies.
    this._containment = containmentRecordForThisSpawn();

    return {
      handle: 'opencode-server',
      serverPid: server.pid,
      port: server.port,
      version: this._detectedVersion || 'unknown',
    };
  }

  async SendPrompt(attempt, prompt) {
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
      const session = await this._request({
        method: 'POST',
        path: this._buildPath('/session'),
        body: sessionBody,
        timeoutMs: SESSION_TIMEOUT_MS,
      });
      this._sessionId = session.id;
      this._backendSessionId = session.id;
    }

    const promptBody = {
      parts: [{ type: 'text', text: prompt }],
    };

    await this._request({
      method: 'POST',
      path: this._buildPath(`/session/${this._sessionId}/prompt_async`),
      body: promptBody,
      timeoutMs: PROMPT_ASYNC_TIMEOUT_MS,
    });
    // The turn is in flight from here, which is what makes a later absence from
    // /session/status meaningful. See the turn module's _fetchSessionStatus.
    this._promptSentAt = Date.now();
    this._lastPrompt = prompt;
  }

  async *Observe(attempt) {
    if (!this._turn) {
      this._turn = new OpencodeTurn({
        transport: this._transport,
        buildPath: (endpoint) => this._buildPath(endpoint),
      });
    }
    yield* this._turn.run({
      prompt: this._lastPrompt,
      session: {
        id: this._sessionId,
        promptSentAt: this._promptSentAt,
        backendPid: this._backendPid,
        containment: this._containment,
      },
      deadline: this._hardDeadlineMs,
      context: { isCancelled: () => this._cancelled },
    });
  }

  Resume(attempt, kind, prompt) {
  }

  async Respond(interactionId, decision) {
    const kind = (typeof decision === 'object' && decision !== null) ? (decision.kind || 'permission') : 'permission';
    const reply = (typeof decision === 'object' && decision !== null) ? (decision.reply || 'reject') : (decision === 'allow' ? 'once' : 'reject');
    const message = (typeof decision === 'object' && decision !== null) ? decision.message : undefined;

    if (reply === 'always') {
      const err = new Error(
        'reply: always is unsupported for unattended opencode jobs. ' +
        'Grant the required access up front with --access.'
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

    try {
      return await this._request({
        method: 'POST',
        path: this._buildPath(endpoint),
        body,
        timeoutMs: 5000,
      });
    } catch (err) {
      if (err && err.statusCode === 404) return { resolved: true };
      throw err;
    }
  }

  async RequestCancel(attempt, rung) {
    if (this._cancelled) return { success: true };

    switch (rung) {
      case 'session_abort':
        if (this._sessionId && this._transport) {
          try {
            await this._request({
              method: 'POST',
              path: this._buildPath(`/session/${this._sessionId}/abort`),
              body: {},
              timeoutMs: 5000,
            });
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
        if (this._server) {
          try {
            const result = await this._server.dispose();
            if (result.gracefulPost !== 'ok') {
              return { success: false, error: 'server_dispose HTTP failed' };
            }
          } catch {
            return { success: false, error: 'server_dispose HTTP failed' };
          }
          this._server = null;
        }
        this._cancelRungReached = 'server_dispose';
        this._cancelled = true;
        return { success: true };

      case 'hard_kill':
        let termination = null;
        if (this._server) termination = await this._server.kill();
        this._cancelRungReached = 'hard_kill';
        this._cancelled = true;
        return { success: true, ...(termination ? { termination } : {}) };

      default:
        return { success: false, error: `Unknown rung: ${rung}` };
    }
  }

  CollectResult(attempt) {
    if (this._collectedResult) return this._collectedResult;

    const turn = this._turn;
    let text = '';
    let usage = { input: 0, output: 0, total: 0 };
    let backendSessionId = null;
    if (turn) {
      text = turn.result.text || '';
      usage = turn.result.usage || usage;
      backendSessionId = turn.result.backendSessionId || null;
    }

    const result = { text, usage, backend_session_id: backendSessionId };
    this._collectedResult = result;
    return result;
  }

  CollectDiagnostics(attempt) {
    return {
      schema_version: 1,
      backend: 'opencode',
      version: this._detectedVersion || 'unknown',
      facts_emitted: this._turn ? this._turn.factCount : 0,
      exit_code: this._turn ? this._turn.exitCode : null,
      interactions_seen: this._turn ? this._turn.seenInteractionCount : 0,
    };
  }

  Dispose(attempt) {
    if (this._disposed) return;
    this._disposed = true;

    if (this._server) {
      const disposeWork = this._server.dispose();
      if (disposeWork && typeof disposeWork.catch === 'function') disposeWork.catch(() => {});
      this._server = null;
    }
  }

  Recover(attempt) {
    if (this._cancelled) return { state: 'cancelled' };
    const turn = this._turn;
    if (turn) {
      if (turn.exitCode !== null) {
        return { state: turn.exitCode === 0 ? 'done' : 'failed' };
      }
      if (turn.hadBackendError) return { state: 'failed' };
    }
    return { state: 'interrupted' };
  }

  // -------------------------------------------------------------------------
  // Doctor probes
  // -------------------------------------------------------------------------

  async _probeEndpointShape(url, method, body, timeoutMs, name, shapeCheck) {
    try {
      const u = new URL(url);
      const transport = new HttpTransport({
        baseUrl: u.origin,
        password: this._server ? this._server.password : null,
      });
      const res = await transport.request({
        method: method || 'GET',
        path: u.pathname + u.search,
        body,
        signal: AbortSignal.timeout(timeoutMs || 5000),
      });
      let parsed = null;
      try { parsed = JSON.parse(res.body); } catch {}
      return shapeCheck({ statusCode: res.status, body: res.body, parsed });
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
    return results;
  }

  async LiveSmoke() {
    const opencodePath = resolveOpencodePath();
    if (!opencodePath) {
      throw new Error('opencode executable not found');
    }
    try {
      const result = runProbe(opencodePath, ['--version'], 10000);
      const version = result.toString().trim();
      if (!version) throw new Error('No version output');
    } catch (err) {
      throw new Error(`opencode not available: ${err.message}`);
    }
  }

  async LiveSmokeRequest(timeoutMs, repoPath) {
    return runAdapterSmoke(this, repoPath);
  }
}

module.exports = { OpencodeAdapter, resolveOpencodePath };
