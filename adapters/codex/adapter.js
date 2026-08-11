const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { buildCmdInvocation } = require('./cmd-quoting');
const { applyProcessLifecycle, terminateProcessTree, containmentRecordForThisSpawn } = require('../shared/process-lifecycle');
const { executableNames, resolveExecutablePath } = require('../shared/resolve-executable');
const { runAdapterSmoke } = require('../../core/adapter-smoke');
const { isGitRepo } = require('../../core/worktree');

const DETECT_VERSION_TIMEOUT_MS = 10000;
const STARTUP_SENTINEL_MS = 10000;
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
 * extensionless JS wrapper and executable-form shims over a bare wrapper.
 *
 * @returns {string}
 */
function resolveCodexPath() {
  return resolveExecutablePath({
    envName: 'CODEX_PATH',
    fallback: 'codex',
    names: executableNames('codex'),
    resolveNear: candidate => /\.exe$/i.test(candidate) ? null : resolveVendorBinaryNear(candidate),
  });
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
 * @param {boolean} [opts.skipGitRepoCheck]  force --skip-git-repo-check; auto-detected otherwise
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

  // Sandbox — maps to access mode.
  //
  // `-s` alone is NOT enough, verified live against codex-cli 0.146.0: under
  // `--ignore-user-config` the flag had no observable effect. `-s read-only`
  // still wrote files (the user's config said workspace-write), and
  // `-s workspace-write` was refused with "writing is blocked by read-only
  // sandbox". So the flag was decorative in both directions — including the
  // direction that matters, where `--access read-only` did not sandbox at all.
  // `-c sandbox_mode=` does take effect, so it is the authoritative one; `-s`
  // stays because it agrees and costs nothing if a later version honours it.
  const sandbox = opts.sandbox || 'read-only';
  argv.push('-s', sandbox);
  argv.push('-c', `sandbox_mode="${sandbox}"`);

  // Under --ignore-user-config the default reviewer auto-rejects every patch
  // in workspace-write ("rejected by user approval settings"), so a write-mode
  // job produced an empty diff and a job that read as cleanly done. There is
  // no approval channel in `codex exec` to answer the prompt, so the reviewer
  // must be the automatic one. Only ever for write access.
  if (sandbox !== 'read-only') {
    argv.push('-c', 'approvals_reviewer="auto_review"');
  }

  // Working directory
  argv.push('-C', opts.workDir);

  // Result file
  argv.push('-o', opts.resultFilePath);

  // Skip git repo check when outside a git repository. The engine allows
  // run/submit in non-git directories (only apply requires a repo), and codex
  // refuses to start there unless told otherwise — auto-detect so a plain
  // directory "just works", with an explicit override for tests/callers.
  if (opts.skipGitRepoCheck || !isGitRepo(opts.workDir)) {
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
  constructor() {
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
    this._liveFacts = [];
    this._liveFactsResolve = null;
    this._lineBuffer = '';
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

  async Start(attempt) {
    // Create temp directory for result file
    this._tmpDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-codex-'));

    // Declared outside the try so the stream/exit wiring below the cleanup
    // block can still reach it.
    let child;

    try {
      this._resultFilePath = path.join(this._tmpDirPath, 'result.txt');

      const codexPath = resolveCodexPath();

      const request = this._lastRequest || {};
      // The engine decides where the job runs — implement mode points
      // canonicalDir at the job's isolated worktree. Using process.cwd()
      // instead sent every implement-mode job at the invoking shell's
      // directory, so the worktree stayed untouched and `diff` was empty.
      const workDir = request.canonicalDir || process.cwd();
      this._workDir = workDir;
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

      child = this._spawn({
        command: invocation.command,
        args: invocation.args,
        options: {
          cwd: invocation.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: invocation.windowsHide,
          // POSIX only. `detached: true` calls setsid(2), putting the child in a
          // new process group whose pgid is the child's pid, so every descendant
          // it spawns is in that group and can be signalled as a unit. On
          // Windows `detached` means a new console instead, which is not
          // containment and would defeat windowsHide — see
          // docs/engineering/windows-spawning.md. Never unref() this child;
          // dcli waits on its exit.
          detached: process.platform !== 'win32',
          // Forward the invocation's own value: it is the single source of truth
          // for how its command line is quoted (adapters/codex/cmd-quoting.js).
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        },
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
      this._lineBuffer += chunk;
      const lines = this._lineBuffer.split('\n');
      this._lineBuffer = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const parsed = this._parseJsonlEvent(line);
        if (parsed) {
          for (const f of parsed) this._liveFacts.push(f);
        }
      }
      this._wakeFactWaiter();
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
      this._wakeObservers();
    });

    child.on('error', (err) => {
      this._facts.push({ type: 'backend_error', class_hint: 'execution_error', structured_payload: { error: err.message } });
      this._observedExited = true;
      this._wakeObservers();
    });
    child.stdin.on('error', (err) => {
      this._facts.push({ type: 'backend_error', class_hint: 'execution_error', structured_payload: { error: err.message } });
      this._observedExited = true;
      this._wakeObservers();
    });

    return { handle: 'codex-process', pid: child.pid, resultFile: this._resultFilePath };
  }

  async SendPrompt(attempt, prompt) {
    if (!this._childProcess || !this._childProcess.stdin) {
      throw new Error('Cannot send prompt: no child process');
    }

    this._facts.push({
      type: 'started',
      backend_pid: this._processPid,
      backend_session_id: null,
      containment: containmentRecordForThisSpawn(),
    });

    // Write prompt to stdin and close it
    this._childProcess.stdin.write(prompt, 'utf8');
    this._childProcess.stdin.end();
    this._stdinClosed = true;
  }

  async *Observe(attempt) {
    yield* this._drainLiveQueue();

    await this._waitForExit();
    await this._waitForStreamDrain();
    this._classifyStderrFailure();

    if (this._lineBuffer) {
      const parsed = this._parseJsonlEvent(this._lineBuffer);
      if (parsed) {
        for (const f of parsed) yield f;
      }
      this._lineBuffer = '';
    }

    yield* this._orderedTerminalFacts();
  }

  async *_drainLiveQueue() {
    while (!this._observedExited) {
      if (this._liveFacts.length > 0) {
        yield this._liveFacts.shift();
      } else {
        await this._waitForFactsOrRecheck();
      }
    }
    while (this._liveFacts.length > 0) {
      yield this._liveFacts.shift();
    }
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
  // Result collection
  // -----------------------------------------------------------------------

  CollectResult(attempt) {
    if (this._collectedResult) return this._collectedResult;

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

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  async Dispose(attempt) {
    if (this._disposed) return;
    this._disposed = true;

    if (this._childProcess) {
      await terminateProcessTree(this._childProcess);
    }

    // Clean up temp directory
    if (this._tmpDirPath) {
      try { fs.rmSync(this._tmpDirPath, { recursive: true, force: true }); } catch {}
    }

    this._childProcess = null;
    this._tmpDirPath = null;
    this._resultFilePath = null;
  }

  // -----------------------------------------------------------------------
  // Smoke test
  // -----------------------------------------------------------------------

  async LiveSmoke(timeoutMs) {
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

  async LiveSmokeRequest(timeoutMs, repoPath) {
    return runAdapterSmoke(this, repoPath);
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
          containment: containmentRecordForThisSpawn(),
        });
        break;

      case 'thread.started':
        facts.push({
          type: 'started',
          backend_pid: this._processPid || null,
          backend_session_id: event.thread_id || event.id || null,
          containment: containmentRecordForThisSpawn(),
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

applyProcessLifecycle(CodexAdapter);

module.exports = { CodexAdapter, buildArgv, resolveCodexPath };
