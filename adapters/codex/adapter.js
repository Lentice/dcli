const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { buildCmdInvocation } = require('./cmd-quoting');

const DETECT_VERSION_TIMEOUT_MS = 10000;
const STARTUP_SENTINEL_MS = 10000;
const POST_EXIT_DRAIN_MS = 3000;
const LIVE_SMOKE_TIMEOUT_MS = 30000;
const MAX_RESULT_BYTES = 1024 * 1024;

/**
 * Given a resolved npm-global JS wrapper path for the `codex` package
 * (typically an extensionless shebang script Node.js cannot spawn without
 * a shell), attempt to locate the real per-platform vendor binary shipped
 * as a sibling `@openai/codex-<platform>-<arch>` optional dependency.
 *
 * @param {string} wrapperPath
 * @returns {string|null}
 */
function resolveVendorBinaryNear(wrapperPath) {
  try {
    // npm global layout: <root>/node_modules/@openai/codex/...
    // The platform-specific vendor package is installed as an optional
    // dependency NESTED inside the `codex` package's own node_modules
    // (<root>/node_modules/@openai/codex/node_modules/@openai/codex-<platform>-<arch>/),
    // not as a sibling at the top-level @openai scope. Search both shapes.
    let dir = path.dirname(wrapperPath);
    const searchRoots = [];
    for (let i = 0; i < 6; i++) {
      const scopeDir = path.join(dir, 'node_modules', '@openai');
      if (fs.existsSync(scopeDir)) searchRoots.push(scopeDir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    for (const scopeDir of searchRoots) {
      // Skip hidden/temp entries (e.g. npm's atomic-install staging dirs
      // like `.codex-<random>`, left behind by an interrupted install) —
      // only the canonical, non-dot-prefixed package name is trustworthy.
      const scopeEntries = fs.readdirSync(scopeDir).filter(e => !e.startsWith('.'));
      // Check nested node_modules under each @openai/<pkg> first (the real
      // shape on this machine), then the scope directory itself (in case
      // a future install places vendor packages as top-level siblings).
      const candidateScopes = [
        ...scopeEntries.map(e => path.join(scopeDir, e, 'node_modules', '@openai')).filter(fs.existsSync),
        scopeDir,
      ];

      for (const candidateScope of candidateScopes) {
        const entries = fs.readdirSync(candidateScope).filter(e => e.startsWith('codex-'));
        for (const entry of entries) {
          const vendorDir = path.join(candidateScope, entry, 'vendor');
          if (!fs.existsSync(vendorDir)) continue;
          for (const target of fs.readdirSync(vendorDir)) {
            const bin = path.join(vendorDir, target, 'bin', 'codex.exe');
            if (fs.existsSync(bin)) return bin;
            const binNoExt = path.join(vendorDir, target, 'bin', 'codex');
            if (fs.existsSync(binNoExt)) return binNoExt;
          }
        }
      }
    }
  } catch {}
  return null;
}

/**
 * Resolve the codex executable path, filtering out .ps1 shims that
 * Node.js cannot spawn, preferring the real vendor binary over an
 * extensionless JS wrapper, and preferring .cmd over a bare wrapper
 * when the vendor binary cannot be located.
 *
 * @returns {string}
 */
function resolveCodexPath() {
  if (process.env.CODEX_PATH) return process.env.CODEX_PATH;

  const { execSync } = require('node:child_process');

  const cmd = process.platform === 'win32'
    ? 'where codex 2>nul'
    : 'which codex 2>/dev/null';

  try {
    const result = execSync(cmd, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const lines = result.trim().split('\n').map(l => l.trim()).filter(Boolean);

    // Skip .ps1 files — Node.js cannot spawn them (PowerShell-only)
    const candidates = lines.filter(l => !l.toLowerCase().endsWith('.ps1'));

    if (candidates.length > 0) {
      // Prefer a real vendor binary reachable from any candidate — this
      // sidesteps the extensionless-wrapper spawn problem entirely.
      for (const candidate of candidates) {
        const vendor = resolveVendorBinaryNear(candidate);
        if (vendor) return vendor;
      }

      // No vendor binary found: prefer .cmd/.bat (spawnable via the
      // documented two-layer cmd.exe quoting) over a bare extensionless
      // file, which Node's spawn() cannot execute without a shell.
      const cmdShim = candidates.find(c => /\.(cmd|bat)$/i.test(c));
      if (cmdShim) return cmdShim;

      return candidates[0];
    }
  } catch {}

  return 'codex';
}

/**
 * Build the argv array for codex exec from request options.
 * Exec-level options must precede the subcommand token.
 *
 * @param {object} opts
 * @param {string} opts.workDir
 * @param {string} opts.resultFilePath
 * @param {string} [opts.sandbox]
 * @param {string} [opts.model]
 * @param {string} [opts.effort]
 * @param {string} [opts.reasoningEffort]
 * @param {string[]} [opts.addDirs]
 * @param {boolean} [opts.skipGitRepoCheck]
 * @returns {string[]}
 */
function buildArgv(opts) {
  const argv = ['exec'];

  argv.push('--json');
  argv.push('--color', 'never');

  // Clean reproducible run
  argv.push('--ephemeral');
  argv.push('--ignore-user-config');
  argv.push('--ignore-rules');

  // Sandbox — maps to access mode
  argv.push('-s', opts.sandbox || 'read-only');

  // Working directory
  argv.push('-C', opts.workDir);

  // Result file
  argv.push('-o', opts.resultFilePath);

  // Skip git repo check when outside a git repository
  if (opts.skipGitRepoCheck) {
    argv.push('--skip-git-repo-check');
  }

  // Additional writable directories
  if (opts.addDirs && opts.addDirs.length > 0) {
    for (const dir of opts.addDirs) {
      argv.push('--add-dir', dir);
    }
  }

  // Model
  if (opts.model) {
    argv.push('-m', opts.model);
  }

  // Reasoning effort maps to -c model_reasoning_effort=<level>
  const effort = opts.effort || opts.reasoningEffort;
  if (effort) {
    argv.push('-c', 'model_reasoning_effort=' + effort);
  }

  // Prompt from stdin
  argv.push('-');

  return argv;
}

class CodexAdapter {
  /**
   * @param {object} [options]
   * @param {boolean} [options._testMode]
   * @param {string} [options._mockVersion]
   * @param {Array} [options._mockFacts]
   * @param {number} [options._mockExitCode]
   */
  constructor(options) {
    const opts = options || {};
    this._testMode = !!opts._testMode;
    this._mockVersion = opts._mockVersion || null;
    this._mockFacts = opts._mockFacts || [];
    this._mockExitCode = opts._mockExitCode !== undefined ? opts._mockExitCode : null;

    this._childProcess = null;
    this._processPid = null;
    this._facts = [];
    this._collectedResult = null;
    this._detectedVersion = null;
    this._disposed = false;
    this._cancelled = false;
    this._cancelRungReached = null;
    this._stdoutContent = '';
    this._stderrContent = '';
    this._resultFilePath = null;
    this._tmpDirPath = null;
    this._lastRequest = null;
    this._stdinClosed = false;
    this._observedExited = false;
    this._drainTimedOut = false;
  }

  get disposed() { return this._disposed; }
  get cancelled() { return this._cancelled; }
  get cancelRungReached() { return this._cancelRungReached; }

  // -----------------------------------------------------------------------
  // Identity
  // -----------------------------------------------------------------------

  GetIdentity() {
    return {
      backend: 'codex',
      adapter_version: '1.0.0',
      state_schema_version: 1,
    };
  }

  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------

  DetectVersion() {
    if (this._testMode) return this._mockVersion || '0.145.0';
    if (this._detectedVersion) return this._detectedVersion;

    const codexPath = resolveCodexPath();
    const { execSync } = require('node:child_process');
    try {
      const result = execSync(
        /\.(cmd|bat)$/i.test(codexPath)
          ? `"${process.env.ComSpec || 'cmd.exe'}" /d /s /c "${codexPath} --version"`
          : `"${codexPath}" --version`,
        {
          encoding: 'utf8',
          timeout: DETECT_VERSION_TIMEOUT_MS,
          windowsHide: true,
        }
      );
      const version = result.toString().trim();
      if (!version) throw new Error('No version output');
      this._detectedVersion = version;
      return this._detectedVersion;
    } catch (err) {
      throw new Error(`Cannot detect codex version: ${err.message}`);
    }
  }

  ProbeCapabilities() {
    return {
      schema_version: 1,
      backend: 'codex',
      backend_version: this._detectedVersion || 'unknown',
      core: { run: true, submit: true, resume: true, cancel: true, wrapper_worktree: true },
      extensions: {
        schema_constrained_output: { supported: true, reason: 'unused - wrapper uses text-based findings' },
      },
      supported_version_range: { min: '0.140.0', max: '0.150.0' },
    };
  }

  DeclareCancelRungs() {
    return ['hard_kill'];
  }

  // -----------------------------------------------------------------------
  // Request validation
  // -----------------------------------------------------------------------

  ValidateRequest(request) {
    if (!request || typeof request !== 'object') return;

    this._lastRequest = { ...request };

    if (request.variant !== undefined && request.variant !== null) {
      const err = new Error(
        '--variant is not supported by backend codex. ' +
        'Use --effort <level> to set reasoning effort. ' +
        "Run 'dcli-codex capabilities --json' for the current surface. " +
        'No job was created.'
      );
      err.code = 'VALIDATION_FAILED';
      err.failureClass = 'unsupported_capability';
      err.optionName = '--variant';
      err.backendName = 'codex';
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Execution lifecycle
  // -----------------------------------------------------------------------

  PrepareInvocation(attempt, request) {
    this._lastRequest = request ? { ...request } : this._lastRequest;
  }

  async Start(attempt) {
    if (this._testMode) {
      this._processPid = 42;
      this._facts = [...this._mockFacts];
      return { handle: 'codex-test-handle' };
    }

    // Create temp directory for result file
    this._tmpDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-codex-'));

    try {
      this._resultFilePath = path.join(this._tmpDirPath, 'result.txt');

      const codexPath = resolveCodexPath();
      const workDir = process.cwd();

      const request = this._lastRequest || {};
      const access = request.access || 'read-only';
      const sandbox = access === 'workspace' ? 'workspace-write' : 'read-only';
      const argv = buildArgv({
        workDir,
        resultFilePath: this._resultFilePath,
        sandbox,
        model: request.model || undefined,
        effort: request.effort || undefined,
        reasoningEffort: request.reasoningEffort || undefined,
        addDirs: request.addDirs || undefined,
        skipGitRepoCheck: request.skipGitRepoCheck || false,
      });

      const invocation = buildCmdInvocation({
        command: codexPath,
        args: argv,
        cwd: workDir,
      });

      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: invocation.windowsHide,
      });

      this._childProcess = child;
      this._processPid = child.pid;
    } catch (err) {
      try { fs.rmSync(this._tmpDirPath, { recursive: true, force: true }); } catch {}
      this._tmpDirPath = null;
      throw err;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      this._stdoutContent += chunk;
    });

    child.stderr.on('data', (chunk) => {
      this._stderrContent += chunk;
    });

    this._stdoutClosed = false;
    this._stderrClosed = false;
    child.stdout.on('close', () => { this._stdoutClosed = true; });
    child.stderr.on('close', () => { this._stderrClosed = true; });

    child.on('exit', (code, signal) => {
      this._facts.push({ type: 'process_exited', code: code !== null ? code : -1 });
      this._observedExited = true;
      if (this._exitResolve) this._exitResolve();
    });

    child.on('error', (err) => {
      this._facts.push({ type: 'backend_error', class_hint: 'execution_error', structured_payload: { error: err.message } });
      this._observedExited = true;
      if (this._exitResolve) this._exitResolve();
    });

    return { handle: 'codex-process', pid: child.pid, resultFile: this._resultFilePath };
  }

  async SendPrompt(attempt, prompt) {
    if (this._testMode) return;

    if (!this._childProcess || !this._childProcess.stdin) {
      throw new Error('Cannot send prompt: no child process');
    }

    this._facts.push({ type: 'started', backend_pid: this._processPid, backend_session_id: null });

    // Write prompt to stdin and close it
    this._childProcess.stdin.write(prompt, 'utf8');
    this._childProcess.stdin.end();
    this._stdinClosed = true;
  }

  async *Observe(attempt) {
    if (this._testMode) {
      for (const fact of this._mockFacts) {
        yield { ...fact };
      }
      return;
    }

    // The real child runs asynchronously — wait for it to actually exit
    // (or error out) before parsing its output. Without this, the
    // generator would return immediately after Start()/SendPrompt(),
    // long before the process has produced any output, since exit is
    // signalled by the 'exit'/'error' event handlers registered in
    // Start(), not by anything synchronous in this function.
    await this._waitForExit();

    // Wait for stdout/stderr streams to fully close (EOF), bounded.
    // Data can arrive after the 'exit' event if a descendant holds a
    // pipe open or OS buffering delays delivery.
    await this._waitForStreamDrain();

    // Yield accumulated facts including process_exited/backend_error
    for (const fact of this._facts) {
      yield { ...fact };
    }

    // Parse JSONL events from stdout
    if (this._stdoutContent) {
      const lines = this._stdoutContent.split('\n').filter(Boolean);
      for (const line of lines) {
        const yielded = this._parseJsonlEvent(line);
        if (yielded) {
          for (const fact of yielded) {
            yield fact;
          }
        }
      }
    }
  }

  /**
   * Resolve once the child process has exited or errored (per the
   * 'exit'/'error' handlers registered in Start(), which set
   * `_observedExited` and call `_exitResolve`). Resolves immediately if
   * that has already happened. Deliberately a REFED (not unref'd) wait —
   * this genuinely needs to keep the event loop alive while real
   * out-of-process work is in flight; an unref'd wait here would let
   * Node exit the whole process before the child's result is ever
   * observed. Has no internal timeout of its own — the caller
   * (executeRun) is responsible for the hard-timeout bound via
   * RequestCancel, which triggers a real process exit and unblocks this.
   *
   * @returns {Promise<void>}
   */
  _waitForExit() {
    if (this._observedExited) return Promise.resolve();
    return new Promise((resolve) => {
      this._exitResolve = resolve;
    });
  }

  Resume(attempt, kind, prompt) {
    if (kind === 'continue_backend_session') {
      // The resume will be handled by the engine (executeResume) which
      // creates a new job and calls Start/SendPrompt on the adapter.
      // For codex, continue_backend_session means the session id from
      // the parent job is carried forward; the actual thread continuation
      // happens at the codex exec resume CLI level.
      this._resumeKind = kind;
      this._resumePrompt = prompt;
    }
  }

  _buildResumeArgv(sessionId, prompt) {
    const codexPath = resolveCodexPath();
    const sessionOpt = sessionId ? [sessionId] : ['--last'];
    const argv = ['exec', 'resume', ...sessionOpt, '--'];
    if (prompt) {
      argv.push(prompt);
    }
    return { command: codexPath, args: argv };
  }

  // -----------------------------------------------------------------------
  // Interaction handling (NOT supported by Codex)
  // -----------------------------------------------------------------------

  Respond(interactionId, decision) {
    throw new Error(
      'Respond is not supported by backend codex. ' +
      'Codex has no interactive permission/response mechanism in exec mode. ' +
      'No job was created.'
    );
  }

  // -----------------------------------------------------------------------
  // Cancellation
  // -----------------------------------------------------------------------

  RequestCancel(attempt, rung) {
    if (this._cancelled) return { success: true };

    if (rung !== 'hard_kill') {
      return { success: false, error: `Unknown rung: ${rung}` };
    }

    if (this._childProcess && !this._childProcess.killed) {
      try {
        this._childProcess.kill('SIGKILL');
      } catch {
        try { this._childProcess.kill(); } catch {}
      }
    }

    this._cancelRungReached = 'hard_kill';
    this._cancelled = true;
    return { success: true };
  }

  // -----------------------------------------------------------------------
  // Result collection
  // -----------------------------------------------------------------------

  CollectResult(attempt) {
    if (this._collectedResult) return this._collectedResult;

    if (this._testMode) {
      let lastText = '';
      let usage = { input: 0, output: 0, total: 0 };
      let backendSessionId = null;

      for (const f of this._mockFacts) {
        if (f.type === 'assistant_text') lastText = f.text;
        if (f.type === 'usage_reported' && f.tokens) usage = { ...f.tokens };
        if (f.type === 'started' && f.backend_session_id) backendSessionId = f.backend_session_id;
      }

      this._collectedResult = { text: lastText, usage, backend_session_id: backendSessionId };
      return this._collectedResult;
    }

    // Read the --output-last-message file
    if (this._resultFilePath) {
      try {
        const stat = fs.statSync(this._resultFilePath);
        if (stat.size === 0) {
          this._collectedResult = { text: '', usage: { input: 0, output: 0, total: 0 }, backend_session_id: null, result_status: 'empty' };
          return this._collectedResult;
        }
        let content;
        let truncated = false;
        if (stat.size > MAX_RESULT_BYTES) {
          const fd = fs.openSync(this._resultFilePath, 'r');
          try {
            const buf = Buffer.alloc(MAX_RESULT_BYTES);
            const bytesRead = fs.readSync(fd, buf, 0, MAX_RESULT_BYTES, 0);
            content = buf.toString('utf8', 0, bytesRead);
          } finally {
            fs.closeSync(fd);
          }
          truncated = true;
        } else {
          content = fs.readFileSync(this._resultFilePath, 'utf8');
        }
        this._collectedResult = { text: content, usage: { input: 0, output: 0, total: 0 }, backend_session_id: null, result_status: truncated ? 'oversize' : 'ok' };
        return this._collectedResult;
      } catch (err) {
        if (err.code === 'ENOENT') {
          this._facts.push({ type: 'backend_error', class_hint: 'execution_error', detail: { reason: 'result_file_missing', path: this._resultFilePath } });
          this._collectedResult = { text: '', usage: { input: 0, output: 0, total: 0 }, backend_session_id: null, result_status: 'missing' };
          return this._collectedResult;
        }
        throw err;
      }
    }

    this._collectedResult = { text: '', usage: { input: 0, output: 0, total: 0 }, backend_session_id: null };
    return this._collectedResult;
  }

  CollectDiagnostics(attempt) {
    return {
      schema_version: 1,
      backend: 'codex',
      version: this._detectedVersion || 'unknown',
      facts_emitted: this._facts.length,
      exit_code: this._resolveExitCode(),
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

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  Dispose(attempt) {
    if (this._disposed) return;
    this._disposed = true;

    if (this._childProcess && !this._childProcess.killed) {
      try { this._childProcess.kill('SIGKILL'); } catch {
        try { this._childProcess.kill(); } catch {}
      }
    }

    // Clean up temp directory
    if (this._tmpDirPath) {
      try { fs.rmSync(this._tmpDirPath, { recursive: true, force: true }); } catch {}
    }

    this._childProcess = null;
    this._tmpDirPath = null;
    this._resultFilePath = null;
  }

  Recover(attempt) {
    if (this._cancelled) return { state: 'cancelled' };
    const exitCode = this._mockExitCode !== null ? this._mockExitCode : 0;
    return { state: exitCode !== 0 ? 'failed' : 'done' };
  }

  // -----------------------------------------------------------------------
  // Smoke test
  // -----------------------------------------------------------------------

  async LiveSmoke(timeoutMs) {
    if (this._testMode) return;
    const codexPath = resolveCodexPath();
    if (!codexPath) {
      throw new Error('codex executable not found');
    }
    const { execSync } = require('node:child_process');
    const effectiveTimeout = timeoutMs || LIVE_SMOKE_TIMEOUT_MS;

    // Probe 1: --version
    try {
      const cmd = /\.(cmd|bat)$/i.test(codexPath)
        ? `"${process.env.ComSpec || 'cmd.exe'}" /d /s /c "${codexPath} --version"`
        : `"${codexPath}" --version`;
      const result = execSync(cmd, { encoding: 'utf8', timeout: effectiveTimeout, windowsHide: true });
      const version = result.toString().trim();
      if (!version) throw new Error('No version output');
    } catch (err) {
      throw new Error(`codex not available: ${err.message}`);
    }

    // Probe 2: codex doctor --json (best-effort, non-fatal)
    try {
      const doctorCmd = /\.(cmd|bat)$/i.test(codexPath)
        ? `"${process.env.ComSpec || 'cmd.exe'}" /d /s /c "${codexPath} doctor --json"`
        : `"${codexPath}" doctor --json`;
      const result = execSync(doctorCmd, { encoding: 'utf8', timeout: effectiveTimeout, windowsHide: true });
      const doctorOutput = result.toString().trim();
      if (doctorOutput) {
        try {
          JSON.parse(doctorOutput);
        } catch {
          // doctor output is present but not JSON; log but don't fail
        }
      }
    } catch {
      // codex doctor --json may not be available in all versions; non-fatal
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  async _waitForStreamDrain() {
    if (this._stdoutClosed && this._stderrClosed) return;
    const deadline = Date.now() + POST_EXIT_DRAIN_MS;
    while (Date.now() < deadline) {
      if (this._stdoutClosed && this._stderrClosed) return;
      await new Promise(r => setTimeout(r, 10));
    }
    this._drainTimedOut = true;
    this._facts.push({ type: 'drain_timeout', message: 'stdout/stderr did not close within POST_EXIT_DRAIN_MS' });
  }

  /**
   * Parse a JSONL event line from the codex exec --json event stream.
   * Maps known event types to closed-set facts. Unknown types are silently
   * skipped (logged to stderr in debug scenarios).
   *
   * @param {string} line
   * @returns {Array|null}
   */
  _parseJsonlEvent(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }

    const type = event.type || '';
    const messageIndex = this._facts.length;
    const facts = [];

    switch (type) {
      case 'text':
      case 'assistant_text':
      case 'message':
        facts.push({
          type: 'assistant_text',
          message_id: `msg_${messageIndex}`,
          text: event.content || event.text || event.message || '',
        });
        break;

      case 'tool_use':
      case 'tool_invocation':
      case 'tool_call':
        facts.push({
          type: 'tool_invoked',
          call_id: event.id || `call_${messageIndex}`,
          tool: event.name || 'unknown',
          summary: event.summary || event.description || (event.input ? JSON.stringify(event.input).slice(0, 200) : 'Tool invoked'),
        });
        break;

      case 'tool_result':
        facts.push({
          type: 'tool_result',
          call_id: event.id || event.call_id || `call_${messageIndex}`,
          ok: !event.error && !event.is_error,
          summary: typeof event.content === 'string' ? event.content.slice(0, 200) : 'Tool result',
        });
        break;

      case 'usage':
      case 'tokens':
        facts.push({
          type: 'usage_reported',
          tokens: {
            input: (event.input_tokens || event.input || 0),
            output: (event.output_tokens || event.output || 0),
            total: (event.total_tokens || event.total || (event.input || 0) + (event.output || 0)),
          },
          cost: event.cost || undefined,
        });
        break;

      case 'error':
      case 'backend_error':
        facts.push({
          type: 'backend_error',
          class_hint: event.class_hint || 'execution_error',
          structured_payload: event.structured_payload || { error: event.content || event.message || 'Unknown error' },
        });
        break;

      case 'started':
      case 'session_start':
        facts.push({
          type: 'started',
          backend_pid: this._processPid || null,
          backend_session_id: event.session_id || event.id || null,
        });
        break;

      case 'thread.started':
        facts.push({
          type: 'started',
          backend_pid: this._processPid || null,
          backend_session_id: event.thread_id || event.id || null,
        });
        break;

      case 'reasoning':
        facts.push({
          type: 'reasoning',
          message_id: event.id || `msg_${messageIndex}`,
        });
        break;

      default:
        break;
    }

    return facts.length > 0 ? facts : null;
  }
}

module.exports = { CodexAdapter, buildArgv, resolveCodexPath };
