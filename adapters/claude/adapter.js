const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { buildCmdInvocation } = require('../codex/cmd-quoting');

const DETECT_VERSION_TIMEOUT_MS = 10000;
const POST_EXIT_DRAIN_MS = 3000;
const LIVE_SMOKE_TIMEOUT_MS = 30000;

function resolveClaudePath() {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;

  const { execSync } = require('node:child_process');

  const cmd = process.platform === 'win32'
    ? 'where claude 2>nul'
    : 'which claude 2>/dev/null';

  try {
    const result = execSync(cmd, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const lines = result.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const candidates = lines.filter(l => !l.toLowerCase().endsWith('.ps1'));
    if (candidates.length > 0) {
      const cmdShim = candidates.find(c => /\.(cmd|bat)$/i.test(c));
      if (cmdShim) return cmdShim;
      return candidates[0];
    }
  } catch {}

  return 'claude';
}

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function buildArgv(opts) {
  const argv = [];

  argv.push('-p');
  argv.push('--output-format', 'stream-json');
  argv.push('--verbose');

  if (opts.sessionId) {
    argv.push('--session-id', opts.sessionId);
  }

  argv.push('--permission-mode', opts.permissionMode || 'auto');

  if (opts.safeMode !== false) {
    argv.push('--safe-mode');
    argv.push('--disable-slash-commands');
  }

  argv.push('--no-session-persistence');

  if (opts.maxBudgetUsd) {
    argv.push('--max-budget-usd', String(opts.maxBudgetUsd));
  }

  if (opts.maxTurns) {
    argv.push('--max-turns', String(opts.maxTurns));
  }

  if (opts.model) {
    argv.push('--model', opts.model);
  }

  if (opts.effort && EFFORT_LEVELS.has(opts.effort)) {
    argv.push('--effort', opts.effort);
  }

  if (opts.addDirs && opts.addDirs.length > 0) {
    for (const dir of opts.addDirs) {
      argv.push('--add-dir', dir);
    }
  }

  return argv;
}

class ClaudeAdapter {
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
    this._liveFacts = [];
    this._liveFactsResolve = null;
    this._lineBuffer = '';
    this._observedExited = false;
    this._drainTimedOut = false;
    this._lastRequest = null;
    this._sessionId = null;
    this._resumeKind = null;
    this._resumePrompt = null;
  }

  get disposed() { return this._disposed; }
  get cancelled() { return this._cancelled; }
  get cancelRungReached() { return this._cancelRungReached; }

  GetIdentity() {
    return {
      backend: 'claude',
      adapter_version: '1.0.0',
      state_schema_version: 1,
    };
  }

  DetectVersion() {
    if (this._testMode) return this._mockVersion || '2.1.220';
    if (this._detectedVersion) return this._detectedVersion;

    const claudePath = resolveClaudePath();
    const { execSync } = require('node:child_process');
    try {
      const result = execSync(
        /\.(cmd|bat)$/i.test(claudePath)
          ? `"${process.env.ComSpec || 'cmd.exe'}" /d /s /c "${claudePath} --version"`
          : `"${claudePath}" --version`,
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
      throw new Error(`Cannot detect claude version: ${err.message}`);
    }
  }

  ProbeCapabilities() {
    return {
      schema_version: 1,
      backend: 'claude',
      backend_version: this._detectedVersion || 'unknown',
      core: { run: true, submit: true, resume: true, cancel: true, wrapper_worktree: true },
      extensions: {
        json_schema_output: { supported: true, reason: 'unused - wrapper uses text-based findings' },
        native_worktree: { supported: true, reason: 'unused - wrapper owns worktree isolation' },
        native_background_jobs: { supported: true, reason: 'unused - bypassed per ADR-005' },
        from_pr: { supported: true, reason: 'unused - not a wrapper-level concept' },
        ultrareview: { supported: true, reason: 'unused - not a wrapper-level concept' },
        recursion_guard: { supported: true, depth_limit: 1 },
      },
      supported_version_range: { min: '2.1.0', max: '2.2.0' },
    };
  }

  DeclareCancelRungs() {
    return ['hard_kill'];
  }

  ValidateRequest(request) {
    if (!request || typeof request !== 'object') return;

    this._lastRequest = { ...request };

    if (request.variant !== undefined && request.variant !== null) {
      const err = new Error(
        '--variant is not supported by backend claude. ' +
        'Use --reasoning-effort <level> to set reasoning effort. ' +
        "Run 'dcli-claude capabilities --json' for the current surface. " +
        'No job was created.'
      );
      err.code = 'VALIDATION_FAILED';
      err.failureClass = 'unsupported_capability';
      err.optionName = '--variant';
      err.backendName = 'claude';
      throw err;
    }
  }

  PrepareInvocation(attempt, request) {
    this._lastRequest = request ? { ...request } : this._lastRequest;
  }

  async Start(attempt) {
    if (this._testMode) {
      this._processPid = 42;
      this._facts = [...this._mockFacts];
      return { handle: 'claude-test-handle' };
    }

    const claudePath = resolveClaudePath();
    const workDir = process.cwd();

    const request = this._lastRequest || {};
    this._sessionId = request.sessionId || crypto.randomUUID();

    const access = request.access || 'read-only';
    const permissionMode = access === 'workspace' ? 'acceptEdits' : 'auto';

    const maxBudget = 0.5;

    const args = buildArgv({
      sessionId: this._sessionId,
      permissionMode,
      safeMode: true,
      maxBudgetUsd: maxBudget,
      model: request.model || undefined,
      effort: request.effort || request.reasoningEffort || undefined,
      addDirs: request.addDirs || undefined,
    });

    const invocation = buildCmdInvocation({
      command: claudePath,
      args,
      cwd: workDir,
    });

    const childEnv = { ...process.env };

    // Stamp recursion guard sentinel
    const currentDepth = parseInt(process.env.DCLI_DEPTH || '0', 10);
    childEnv.DCLI_WORKER = '1';
    childEnv.DCLI_DEPTH = String(currentDepth + 1);

    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: invocation.windowsHide,
      env: childEnv,
    });

    this._childProcess = child;
    this._processPid = child.pid;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      this._stdoutContent += chunk;
      this._lineBuffer += chunk;
      const lines = this._lineBuffer.split('\n');
      this._lineBuffer = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const parsed = this._parseStreamEvent(line);
        if (parsed) {
          for (const f of parsed) this._liveFacts.push(f);
        }
      }
      if (this._liveFactsResolve) {
        const r = this._liveFactsResolve;
        this._liveFactsResolve = null;
        r();
      }
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

    return { handle: 'claude-process', pid: child.pid, sessionId: this._sessionId };
  }

  async SendPrompt(attempt, prompt) {
    if (this._testMode) return;

    if (!this._childProcess || !this._childProcess.stdin) {
      throw new Error('Cannot send prompt: no child process');
    }

    this._facts.push({ type: 'started', backend_pid: this._processPid, backend_session_id: this._sessionId });

    this._childProcess.stdin.write(prompt, 'utf8');
    this._childProcess.stdin.end();
  }

  async *Observe(attempt) {
    if (this._testMode) {
      for (const fact of this._mockFacts) {
        yield { ...fact };
      }
      return;
    }

    yield* this._drainLiveQueue();

    await this._waitForExit();
    await this._waitForStreamDrain();

    if (this._lineBuffer) {
      const parsed = this._parseStreamEvent(this._lineBuffer);
      if (parsed) {
        for (const f of parsed) yield f;
      }
      this._lineBuffer = '';
    }

    for (const fact of this._facts) {
      yield { ...fact };
    }
  }

  async *_drainLiveQueue() {
    while (!this._observedExited) {
      if (this._liveFacts.length > 0) {
        yield this._liveFacts.shift();
      } else {
        await new Promise((resolve) => {
          this._liveFactsResolve = resolve;
        });
      }
    }
    while (this._liveFacts.length > 0) {
      yield this._liveFacts.shift();
    }
  }

  _waitForExit() {
    if (this._observedExited) return Promise.resolve();
    return new Promise((resolve) => {
      this._exitResolve = resolve;
    });
  }

  Resume(attempt, kind, prompt) {
    if (kind === 'continue_backend_session') {
      this._resumeKind = kind;
      this._resumePrompt = prompt;
    }
  }

  Respond(interactionId, decision) {
    throw new Error(
      'Respond is not supported by backend claude. ' +
      'Claude has no interactive permission/response mechanism in -p/--print mode. ' +
      'No job was created.'
    );
  }

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

    const collected = this._collectResultFromEvents();
    this._collectedResult = collected;
    return collected;
  }

  _collectResultFromEvents() {
    let lastText = '';
    let usage = { input: 0, output: 0, total: 0 };
    let backendSessionId = this._sessionId;

    if (this._stdoutContent) {
      const lines = this._stdoutContent.split('\n').filter(Boolean);
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }

        if (event.type === 'assistant' && event.message && event.message.content) {
          for (const part of event.message.content) {
            if (part.type === 'text' && part.text) {
              lastText = part.text;
            }
          }
        }

        if (event.type === 'result') {
          if (event.usage) {
            usage = {
              input: event.usage.input_tokens || event.usage.input || 0,
              output: event.usage.output_tokens || event.usage.output || 0,
              total: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0),
            };
          }
          if (event.session_id) {
            backendSessionId = event.session_id;
          }
        }
      }
    }

    return { text: lastText, usage, backend_session_id: backendSessionId };
  }

  CollectDiagnostics(attempt) {
    return {
      schema_version: 1,
      backend: 'claude',
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

  Dispose(attempt) {
    if (this._disposed) return;
    this._disposed = true;

    if (this._childProcess && !this._childProcess.killed) {
      try { this._childProcess.kill('SIGKILL'); } catch {
        try { this._childProcess.kill(); } catch {}
      }
    }

    this._childProcess = null;
  }

  Recover(attempt) {
    if (this._cancelled) return { state: 'cancelled' };
    const facts = this._facts || [];
    const processExited = facts.find(f => f && f.type === 'process_exited');
    if (processExited) {
      return { state: processExited.code === 0 ? 'done' : 'failed' };
    }
    const backendError = facts.find(f => f && f.type === 'backend_error');
    if (backendError) return { state: 'failed' };
    return { state: 'interrupted' };
  }

  async LiveSmoke(timeoutMs) {
    if (this._testMode) return;
    const claudePath = resolveClaudePath();
    if (!claudePath) {
      throw new Error('claude executable not found');
    }
    const { execSync } = require('node:child_process');
    try {
      const cmd = /\.(cmd|bat)$/i.test(claudePath)
        ? `"${process.env.ComSpec || 'cmd.exe'}" /d /s /c "${claudePath} --version"`
        : `"${claudePath}" --version`;
      const result = execSync(cmd, { encoding: 'utf8', timeout: timeoutMs || LIVE_SMOKE_TIMEOUT_MS, windowsHide: true });
      const version = result.toString().trim();
      if (!version) throw new Error('No version output');
    } catch (err) {
      throw new Error(`claude not available: ${err.message}`);
    }
  }

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

  _parseStreamEvent(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }

    const type = event.type || '';
    const facts = [];

    switch (type) {
      case 'assistant':
        if (event.message && event.message.content) {
          for (const part of event.message.content) {
            if (part.type === 'text' && part.text) {
              facts.push({
                type: 'assistant_text',
                message_id: event.message.id || `msg_${Date.now()}`,
                text: part.text,
              });
            }
          }
        }
        if (event.message && event.message.usage) {
          const u = event.message.usage;
          facts.push({
            type: 'usage_reported',
            tokens: {
              input: u.input_tokens || 0,
              output: u.output_tokens || 0,
              total: (u.input_tokens || 0) + (u.output_tokens || 0),
            },
          });
        }
        break;

      case 'result':
        if (event.is_error && event.errors && event.errors.length > 0) {
          facts.push({
            type: 'backend_error',
            class_hint: event.terminal_reason || 'execution_error',
            structured_payload: { errors: event.errors, terminal_reason: event.terminal_reason },
          });
        }
        if (event.permission_denials && event.permission_denials.length > 0) {
          for (const denial of event.permission_denials) {
            facts.push({
              type: 'backend_error',
              class_hint: 'permission_or_sandbox',
              structured_payload: { denial },
            });
          }
        }
        break;

      case 'system':
        if (event.subtype === 'init' && event.session_id) {
          facts.push({
            type: 'started',
            backend_pid: this._processPid || null,
            backend_session_id: event.session_id,
          });
        }
        break;

      default:
        break;
    }

    return facts.length > 0 ? facts : null;
  }
}

module.exports = { ClaudeAdapter, buildArgv, resolveClaudePath, EFFORT_LEVELS };
