const crypto = require('node:crypto');
const { buildCmdInvocation } = require('../codex/cmd-quoting');
const { runProbe } = require('../shared/run-probe');
const { applyProcessLifecycle, terminateProcessTree, containmentRecordForThisSpawn } = require('../shared/process-lifecycle');
const { executableNames, resolveExecutablePath } = require('../shared/resolve-executable');
const { runAdapterSmoke } = require('../../core/adapter-smoke');
const {
  MAX_RETAINED_STREAM_BYTES,
  TRUNCATION_PREFIX,
  appendRetained,
  withTruncationMarker,
  capPartialLine,
} = require('../shared/stream-retention');

const DETECT_VERSION_TIMEOUT_MS = 10000;
const LIVE_SMOKE_TIMEOUT_MS = 30000;

function resolveClaudePath() {
  return resolveExecutablePath({
    envName: 'CLAUDE_PATH',
    fallback: 'claude',
    names: executableNames('claude'),
  });
}

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function buildArgv(opts) {
  const argv = [];

  argv.push('-p');
  argv.push('--output-format', 'stream-json');
  argv.push('--verbose');

  // `--session-id` names a NEW session; `--resume` continues an existing one.
  // Passing the parent's id as --session-id started a fresh conversation that
  // merely reused the uuid, so a continue_backend_session resume answered with
  // no memory of the parent turn while reporting success.
  if (opts.resumeSessionId) {
    argv.push('--resume', opts.resumeSessionId);
  } else if (opts.sessionId) {
    argv.push('--session-id', opts.sessionId);
  }

  argv.push('--permission-mode', opts.permissionMode || 'auto');

  if (opts.safeMode !== false) {
    argv.push('--safe-mode');
    argv.push('--disable-slash-commands');
  }

  // No `--no-session-persistence`. It and resume are mutually exclusive —
  // docs/reference/cli-claude.md: "sessions not saved to disk and cannot be
  // resumed" — and this adapter declares core.resume and records a
  // backend_session_id. Passing it anyway meant the recorded id named a
  // conversation that was never written, and every continue_backend_session
  // resume died with "No conversation found with session ID". Isolation is
  // enforced by --safe-mode, --permission-mode and the access mode, not by
  // refusing to write the transcript.

  if (opts.maxBudgetUsd) {
    argv.push('--max-budget-usd', String(opts.maxBudgetUsd));
  }

  if (opts.maxTurns) {
    argv.push('--max-turns', String(opts.maxTurns));
  }

  if (opts.model) {
    argv.push('--model', opts.model);
  }

  if (opts.effort) {
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
    this._stdoutTruncatedBytes = 0;
    this._stderrTruncatedBytes = 0;
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
    if (this._detectedVersion) return this._detectedVersion;

    const claudePath = resolveClaudePath();
    try {
      const result = runProbe(claudePath, ['--version'], DETECT_VERSION_TIMEOUT_MS);
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

  ValidateRequest(request) {
    if (!request || typeof request !== 'object') return;

    this._lastRequest = { ...request };

    if (request.variant !== undefined && request.variant !== null) {
      const err = new Error(
        '--variant is not supported by backend claude. ' +
        'Use --effort <level> to set reasoning effort. ' +
        "Run 'dcli-claude capabilities --json' for the current surface. " +
        'No job was created.'
      );
      err.code = 'VALIDATION_FAILED';
      err.failureClass = 'unsupported_capability';
      err.optionName = '--variant';
      err.backendName = 'claude';
      throw err;
    }

    for (const [optionName, value] of [
      ['--effort', request.effort],
    ]) {
      if (value !== undefined && value !== null && !EFFORT_LEVELS.has(value)) {
        const err = new Error(
          `${optionName} must be one of ${[...EFFORT_LEVELS].join(', ')} for backend claude. ` +
          'No job was created.'
        );
        err.code = 'VALIDATION_FAILED';
        err.failureClass = 'usage_error';
        err.optionName = optionName;
        err.backendName = 'claude';
        throw err;
      }
    }
  }

  async Start(attempt) {
    const claudePath = resolveClaudePath();

    const request = this._lastRequest || {};
    // See the codex adapter: canonicalDir is the engine's decision about where
    // the job runs, and in implement mode it is the isolated worktree, not the
    // invoking shell's directory.
    const workDir = request.canonicalDir || process.cwd();
    // Recorded so the directory the child actually ran in is observable: it
    // reaches the child only as a spawn cwd, which ChildProcess does not expose.
    this._workDir = workDir;
    // A continued session keeps the parent's id; otherwise this is a new one.
    this._resumeSessionId = request.resumeSessionId || null;
    this._sessionId = this._resumeSessionId || request.sessionId || crypto.randomUUID();

    const access = request.access || 'read-only';
    const permissionMode = access === 'workspace' ? 'acceptEdits' : 'auto';

    const maxBudget = 20;

    const args = buildArgv({
      sessionId: this._sessionId,
      resumeSessionId: this._resumeSessionId || undefined,
      permissionMode,
      safeMode: true,
      maxBudgetUsd: maxBudget,
      model: request.model || undefined,
      effort: request.effort || undefined,
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

    const child = this._spawn({
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
        env: childEnv,
      },
    });

    this._childProcess = child;
    this._processPid = child.pid;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      this._appendStdout(chunk);
      this._lineBuffer = capPartialLine(this._lineBuffer, chunk);
      const lines = this._lineBuffer.split('\n');
      this._lineBuffer = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const parsed = this._parseStreamEvent(line);
        if (parsed) {
          for (const f of parsed) this._liveFacts.push(f);
        }
      }
      this._wakeFactWaiter();
    });

    child.stderr.on('data', (chunk) => {
      this._appendStderr(chunk);
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

    return { handle: 'claude-process', pid: child.pid, sessionId: this._sessionId };
  }

  async SendPrompt(attempt, prompt) {
    if (!this._childProcess || !this._childProcess.stdin) {
      throw new Error('Cannot send prompt: no child process');
    }

    this._facts.push({
      type: 'started',
      backend_pid: this._processPid,
      backend_session_id: this._sessionId,
      containment: containmentRecordForThisSpawn(),
    });

    this._childProcess.stdin.write(prompt, 'utf8');
    this._childProcess.stdin.end();
  }

  async *Observe(attempt) {
    yield* this._drainLiveQueue();

    await this._waitForExit();
    await this._waitForStreamDrain();
    this._classifyStderrFailure();

    if (this._lineBuffer) {
      const parsed = this._parseStreamEvent(this._lineBuffer);
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

  CollectResult(attempt) {
    if (this._collectedResult) return this._collectedResult;

    const collected = this._collectResultFromEvents();
    this._collectedResult = collected;
    return collected;
  }

  _collectResultFromEvents() {
    let lastText = '';
    let usage = { input: 0, output: 0, total: 0 };
    let backendSessionId = this._sessionId;
    let sawResult = false;

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
          sawResult = true;
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

    return {
      text: lastText,
      usage,
      backend_session_id: backendSessionId,
      result_status: sawResult ? 'present' : 'missing',
    };
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

  async Dispose(attempt) {
    if (this._disposed) return;
    this._disposed = true;

    if (this._childProcess) {
      await terminateProcessTree(this._childProcess);
    }

    this._childProcess = null;
  }

  // -----------------------------------------------------------------------
  // Stream retention (ticket 116)
  // -----------------------------------------------------------------------

  /**
   * Retain a stdout chunk within MAX_RETAINED_STREAM_BYTES, keeping the
   * newest bytes on whole-line boundaries, and stamp a truncation marker at
   * the front once bytes have been dropped. _collectResultFromEvents later
   * splits this retained content and parses each line with a try/catch, so a
   * truncation marker line (or a line the cap cut) is skipped, never fatal;
   * the result section lives at the tail of the stream and survives the cap.
   */
  _appendStdout(chunk) {
    const applied = appendRetained(this._stdoutContent, chunk, MAX_RETAINED_STREAM_BYTES);
    this._stdoutContent = applied.content;
    this._stdoutTruncatedBytes += applied.dropped;
    if (applied.dropped > 0 && !this._stdoutContent.startsWith(TRUNCATION_PREFIX)) {
      this._stdoutContent = withTruncationMarker(this._stdoutContent, MAX_RETAINED_STREAM_BYTES, this._stdoutTruncatedBytes);
    }
  }

  /**
   * Retain a stderr chunk within MAX_RETAINED_STREAM_BYTES, tail-keeping
   * with a truncation marker. stderr is never parsed, so the cap is a pure
   * memory bound.
   */
  _appendStderr(chunk) {
    const applied = appendRetained(this._stderrContent, chunk, MAX_RETAINED_STREAM_BYTES);
    this._stderrContent = applied.content;
    this._stderrTruncatedBytes += applied.dropped;
    if (applied.dropped > 0 && !this._stderrContent.startsWith(TRUNCATION_PREFIX)) {
      this._stderrContent = withTruncationMarker(this._stderrContent, MAX_RETAINED_STREAM_BYTES, this._stderrTruncatedBytes);
    }
  }

  async LiveSmoke(timeoutMs) {
    const claudePath = resolveClaudePath();
    if (!claudePath) {
      throw new Error('claude executable not found');
    }
    try {
      const result = runProbe(claudePath, ['--version'], timeoutMs || LIVE_SMOKE_TIMEOUT_MS);
      const version = result.toString().trim();
      if (!version) throw new Error('No version output');
    } catch (err) {
      throw new Error(`claude not available: ${err.message}`);
    }
  }

  async LiveSmokeRequest(timeoutMs, repoPath) {
    return runAdapterSmoke(this, repoPath);
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

applyProcessLifecycle(ClaudeAdapter);

module.exports = { ClaudeAdapter, buildArgv, resolveClaudePath, EFFORT_LEVELS };
