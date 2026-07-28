const { spawn } = require('node:child_process');
const { DEFAULTS, resolveDeadline, validateTimeoutMs } = require('./deadlines');

const DEFAULT_MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 10 * 1024 * 1024;

class ManagedProcess {
  /**
   * @param {{
   *   command: string,
   *   args?: string[],
   *   cwd?: string,
   *   env?: Record<string, string>,
   *   hardTimeoutMs?: number,
   *   postExitDrainMs?: number,
   *   startupSentinelMs?: number,
   *   maxStdoutBytes?: number,
   *   maxStderrBytes?: number,
   * }} options
   */
  constructor(options) {
    this._options = options;
    this._command = options.command;
    this._args = options.args || [];

    const hardMs = options.hardTimeoutMs !== undefined
      ? validateTimeoutMs(options.hardTimeoutMs, 'hardTimeoutMs')
      : 0;
    this._hardTimeoutMs = hardMs;
    this._postExitDrainMs = options.postExitDrainMs || DEFAULTS.POST_EXIT_DRAIN_MS;
    this._startupSentinelMs = options.startupSentinelMs !== undefined
      ? validateTimeoutMs(options.startupSentinelMs, 'startupSentinelMs')
      : resolveDeadline('WORKER_STARTUP_SENTINEL_MS', null, 'DCLI_STARTUP_TIMEOUT');
    this._maxStdoutBytes = options.maxStdoutBytes || DEFAULT_MAX_STDOUT_BYTES;
    this._maxStderrBytes = options.maxStderrBytes || DEFAULT_MAX_STDERR_BYTES;

    this._process = null;
    this._pid = null;
    this._exitCode = null;
    this._exitSignal = null;
    this._exitError = null;
    this._killed = false;
    this._consumerRegistered = false;
    this._stdinClosed = false;
    this._timedOut = false;

    this._stdoutContent = '';
    this._stderrContent = '';
    this._stdoutOverflow = false;
    this._stderrOverflow = false;

    this._onStdoutCb = null;
    this._onStderrCb = null;
    this._onExitCb = null;
    this._onErrorCb = null;

    this._exitPromise = new Promise((resolve) => {
      this._exitResolve = resolve;
    });

    this._hardTimeoutTimer = null;
    this._startupTimer = null;

    this._spawn();
  }

  /** @returns {number|null} */
  get pid() {
    return this._pid;
  }

  /** @returns {string} */
  get stdoutContent() {
    return this._stdoutContent;
  }

  /** @returns {string} */
  get stderrContent() {
    return this._stderrContent;
  }

  /** @returns {number|null} */
  get exitCode() {
    return this._exitCode;
  }

  /** @returns {boolean} */
  get stdoutOverflow() {
    return this._stdoutOverflow;
  }

  /** @returns {boolean} */
  get stderrOverflow() {
    return this._stderrOverflow;
  }

  /** @returns {boolean} */
  get timedOut() {
    return this._timedOut;
  }

  _spawn() {
    try {
      this._process = spawn(this._command, this._args, {
        cwd: this._options ? this._options.cwd : undefined,
        env: this._options ? this._options.env : undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this._exitError = err;
      if (this._exitResolve) {
        this._exitResolve({ code: null, signal: null, error: err, timedOut: false });
      }
      if (this._onErrorCb) this._onErrorCb(err);
      return;
    }

    this._pid = this._process.pid;

    // Start hard timeout immediately after spawn — the deadline includes
    // any time spent blocked on stdin write.
    if (this._hardTimeoutMs > 0) {
      this._hardTimeoutTimer = setTimeout(() => this._onHardTimeout(), this._hardTimeoutMs);
      this._hardTimeoutTimer.unref();
    }

    // Capture stdout/stderr immediately — structural read-before-write.
    // These listeners start consuming before any code can write stdin.
    this._process.stdout.setEncoding('utf8');
    this._process.stderr.setEncoding('utf8');

    this._process.stdout.on('data', (chunk) => {
      if (typeof chunk === 'string') {
        if (this._stdoutContent.length < this._maxStdoutBytes) {
          this._stdoutContent += chunk;
          if (this._stdoutContent.length > this._maxStdoutBytes) {
            this._stdoutContent = this._stdoutContent.slice(0, this._maxStdoutBytes);
            this._stdoutOverflow = true;
          }
        }
        if (this._onStdoutCb) this._onStdoutCb(chunk);
      }
    });

    this._process.stderr.on('data', (chunk) => {
      if (typeof chunk === 'string') {
        if (this._stderrContent.length < this._maxStderrBytes) {
          this._stderrContent += chunk;
          if (this._stderrContent.length > this._maxStderrBytes) {
            this._stderrContent = this._stderrContent.slice(0, this._maxStderrBytes);
            this._stderrOverflow = true;
          }
        }
        if (this._onStderrCb) this._onStderrCb(chunk);
      }
    });

    this._process.on('exit', (code, signal) => {
      this._exitCode = code;
      this._exitSignal = signal;
      this._cancelTimers();
      if (this._exitResolve) {
        this._exitResolve({ code, signal, error: null, timedOut: this._timedOut });
      }
      if (this._onExitCb) this._onExitCb(code, signal);
    });

    this._process.on('error', (err) => {
      this._exitError = err;
      this._cancelTimers();
      if (this._exitResolve) {
        this._exitResolve({ code: null, signal: null, error: err, timedOut: false });
      }
      if (this._onErrorCb) this._onErrorCb(err);
    });

    this._startSentinel();
  }

  _cancelTimers() {
    if (this._hardTimeoutTimer) {
      clearTimeout(this._hardTimeoutTimer);
      this._hardTimeoutTimer = null;
    }
    if (this._startupTimer) {
      clearTimeout(this._startupTimer);
      this._startupTimer = null;
    }
  }

  _startSentinel() {
    if (this._startupSentinelMs <= 0) return;
    if (this._exitCode !== null || this._exitError) return;

    this._startupTimer = setTimeout(() => {
      this._startupTimer = null;
      // If process is dead with no output, fail fast
      if (this._exitCode !== null && this._stdoutContent.length === 0 && this._stderrContent.length === 0) {
        // Already resolved via exit event — nothing to do
      }
    }, this._startupSentinelMs);
    this._startupTimer.unref();
  }

  _onHardTimeout() {
    if (this._killed || this._exitCode !== null) return;
    this._timedOut = true;
    this._kill('hard_timeout');
  }

  /**
   * Register a stdout data callback. Must be called before sendStdin.
   * @param {(chunk: string) => void} cb
   */
  onStdout(cb) {
    this._consumerRegistered = true;
    this._onStdoutCb = cb;
  }

  /**
   * Register a stderr data callback. Must be called before sendStdin.
   * @param {(chunk: string) => void} cb
   */
  onStderr(cb) {
    this._consumerRegistered = true;
    this._onStderrCb = cb;
  }

  /**
   * Register an exit callback.
   * @param {(code: number|null, signal: string|null) => void} cb
   */
  onExit(cb) {
    this._onExitCb = cb;
  }

  /**
   * Register an error callback.
   * @param {(err: Error) => void} cb
   */
  onError(cb) {
    this._onErrorCb = cb;
  }

  /**
   * Write text to stdin. Throws if no consumer is registered yet (enforcing
   * read-before-write).
   * @param {string} text
   */
  sendStdin(text) {
    if (!this._consumerRegistered) {
      throw new Error(
        'Cannot write stdin before registering a stdout/stderr consumer. ' +
        'Call onStdout() or onStderr() before sendStdin() to prevent pipe deadlock.'
      );
    }
    if (!this._process || !this._process.stdin) {
      throw new Error('Process stdin is not available');
    }
    if (this._stdinClosed) {
      throw new Error('stdin is already closed');
    }
    this._process.stdin.write(text, 'utf8');
  }

  /**
   * Close stdin, signaling EOF to the child process.
   */
  closeStdin() {
    if (this._stdinClosed) return;
    this._stdinClosed = true;
    if (this._process && this._process.stdin) {
      try {
        this._process.stdin.end();
      } catch {
        // ignore if already destroyed
      }
    }
  }

  /**
   * Wait for the process to exit, with a bounded timeout.
   * @param {number} [timeoutMs]
   * @returns {Promise<{ code: number|null, signal: string|null, error: Error|null, timedOut: boolean }>}
   */
  async waitForExit(timeoutMs) {
    if (this._exitCode !== null || this._exitError) {
      return {
        code: this._exitCode,
        signal: this._exitSignal,
        error: this._exitError,
        timedOut: this._timedOut,
      };
    }

    const exitPromise = this._exitPromise;

    if (timeoutMs && timeoutMs > 0) {
      const timer = setTimeout(() => {
        this._timedOut = true;
      }, timeoutMs);
      timer.unref();

      const result = await Promise.race([
        exitPromise,
        new Promise(resolve => {
          const t = setTimeout(() => {
            resolve({
              code: null,
              signal: null,
              error: new Error(`waitForExit timed out after ${timeoutMs}ms`),
              timedOut: true,
            });
          }, timeoutMs);
          t.unref();
        }),
      ]);

      clearTimeout(timer);
      return result;
    }

    return exitPromise;
  }

  /**
   * Bounded drain of remaining output after process exit.
   * Gives any queued data time to arrive before returning.
   * @param {number} [timeoutMs]
   * @returns {Promise<{ stdout: string, stderr: string, timedOut: boolean }>}
   */
  async drainOutput(timeoutMs) {
    const drainMs = timeoutMs || this._postExitDrainMs;

    await sleep(Math.min(drainMs, 2000));

    return {
      stdout: this._stdoutContent,
      stderr: this._stderrContent,
      timedOut: this._timedOut,
    };
  }

  /**
   * Teardown: close stdin → kill → bounded drain.
   */
  async _kill(reason) {
    if (this._killed) return;
    this._killed = true;

    this._cancelTimers();

    // 1. Close stdin
    this.closeStdin();

    // 2. Kill the process
    if (this._process && !this._process.killed) {
      try {
        this._process.kill('SIGKILL');
      } catch {
        try { this._process.kill(); } catch {}
      }
    }

    // 3. Bounded drain
    await sleep(Math.min(500, this._postExitDrainMs));
  }

  /**
   * Explicitly kill the process and wait for cleanup.
   * @returns {Promise<{ stdout: string, stderr: string }>}
   */
  async kill() {
    await this._kill('explicit_kill');
    return {
      stdout: this._stdoutContent,
      stderr: this._stderrContent,
    };
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { ManagedProcess };
