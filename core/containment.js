const { spawn } = require('node:child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const HELPER_RELATIVE_PATH_DEBUG = path.resolve(__dirname, '..', 'native', 'windows-job-helper', 'bin', 'Debug', 'net10.0', 'contain.exe');
const HELPER_RELATIVE_PATH_RELEASE = path.resolve(__dirname, '..', 'native', 'windows-job-helper', 'bin', 'Release', 'contain.exe');

/**
 * @param {string} [helperPath]
 * @returns {string}
 */
function resolveHelperPath(helperPath) {
  if (helperPath) return helperPath;
  if (fs.existsSync(HELPER_RELATIVE_PATH_RELEASE)) return HELPER_RELATIVE_PATH_RELEASE;
  return HELPER_RELATIVE_PATH_DEBUG;
}

/**
 * @param {string} [helperPath]
 * @returns {boolean}
 */
function isAvailable(helperPath) {
  try { return fs.existsSync(resolveHelperPath(helperPath)); }
  catch { return false; }
}

const HELPER_PATH = HELPER_RELATIVE_PATH_DEBUG;

/**
 * One containment helper process = one Job Object = one process tree.
 * Async methods using event-driven I/O.
 */
class ContainmentContext {
  /**
   * @param {string} [helperPath]
   */
  constructor(helperPath) {
    const hp = resolveHelperPath(helperPath);
    if (!fs.existsSync(hp)) {
      throw new Error(`Containment helper not found at ${hp}. Build it: dotnet build native/windows-job-helper`);
    }

    this._helperPath = hp;
    this._process = null;
    this._executionToken = null;
    this._childPid = null;
    this._closed = false;
    this._buffer = '';
    /** @type {Map<string, {resolve: Function, reject: Function, timeout: NodeJS.Timeout}>} */
    this._pending = new Map();

    this._process = spawn(hp, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this._process.stdout.on('data', (chunk) => this._onData(chunk));
    this._process.on('error', () => this._rejectAll(new Error('Helper process error')));
    this._process.on('exit', (code) => {
      if (!this._closed) {
        this._rejectAll(new Error(`Helper exited with code ${code}`));
      }
    });
  }

  /**
   * Parse incoming NDJSON from the helper and resolve pending promises.
   * @param {Buffer|string} chunk
   */
  _onData(chunk) {
    this._buffer += chunk.toString();
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { continue; }

      if (msg.type === 'started') {
        this._resolvePending('started', msg);
      } else if (msg.type === 'terminated') {
        this._resolvePending('terminated', msg);
      } else if (msg.type === 'exited') {
        this._resolvePending('exited', msg);
      } else if (msg.type === 'error') {
        // Reject the earliest pending promise with the error
        for (const [key, entry] of this._pending) {
          clearTimeout(entry.timeout);
          this._pending.delete(key);
          entry.reject(new Error(msg.error));
          break;
        }
      } else if (msg.type === 'stdout') {
        this._resolvePending('stdout', msg);
      } else if (msg.type === 'stderr') {
        this._resolvePending('stderr', msg);
      }
    }
  }

  /**
   * Resolve the earliest pending entry for a given type.
   * @param {string} msgType
   * @param {object} msg
   */
  _resolvePending(msgType, msg) {
    // Resolve by matching type — use the earliest matching entry
    for (const [key, entry] of this._pending) {
      const expectedType = key.split('|')[0];
      if (expectedType === msgType || expectedType === 'any') {
        clearTimeout(entry.timeout);
        this._pending.delete(key);
        entry.resolve(msg);
        return;
      }
    }
  }

  /**
   * Reject all pending promises.
   * @param {Error} err
   */
  _rejectAll(err) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timeout);
      entry.reject(err);
    }
    this._pending.clear();
  }

  /**
   * Send a command and wait for a response of the given expected type.
   * @param {object} msg - JSON-serializable command
   * @param {string} expectedType - expected response type ('started', 'terminated', 'error')
   * @param {number} [timeoutMs]
   * @returns {Promise<object>}
   */
  _send(msg, expectedType, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const key = `${expectedType}|${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const timeout = setTimeout(() => {
        this._pending.delete(key);
        reject(new Error(`Timeout waiting for '${expectedType}' response (${timeoutMs}ms)`));
      }, timeoutMs);

      this._pending.set(key, { resolve, reject, timeout });

      try {
        this._process.stdin.write(JSON.stringify(msg) + '\n');
      } catch (e) {
        clearTimeout(timeout);
        this._pending.delete(key);
        reject(new Error(`Failed to write to helper: ${e.message}`));
      }
    });
  }

  /**
   * Spawn a process inside the Job Object.
   *
   * @param {{ args: string[], cwd?: string, env?: Record<string,string>, stdio?: 'pipe'|'inherit'|'null' }} options
   * @returns {Promise<{ pid: number, executionToken: string, creationTime: string }>}
   */
  async spawn(options) {
    if (!this._process || this._process.killed || this._closed) {
      throw new Error('Containment context is closed');
    }

    const { args, cwd, env, stdio = 'null' } = options;
    const cmd = {
      type: 'command', command: 'spawn', id: 1,
      args,
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
      stdio,
    };

    const msg = await this._send(cmd, 'started', 10000);
    if (msg.type === 'started') {
      this._executionToken = msg.execution_token;
      this._childPid = msg.pid;
      return { pid: msg.pid, executionToken: msg.execution_token, creationTime: msg.creation_time };
    }
    throw new Error(`Unexpected spawn response: ${JSON.stringify(msg)}`);
  }

  /**
   * Terminate the Job Object.
   * @param {{ executionToken?: string, graceMs?: number }} [opts]
   * @returns {Promise<{ terminated: boolean, survivors: number[], error?: string }>}
   */
  async terminate(opts = {}) {
    if (!this._process || this._process.killed || this._closed) {
      throw new Error('Containment context is closed');
    }

    const { executionToken, graceMs = 5000 } = opts;
    const cmd = {
      type: 'command', command: 'terminate', id: 2,
      ...(executionToken ? { execution_token: executionToken } : {}),
      grace_ms: graceMs,
    };

    const msg = await this._send(cmd, 'terminated', 30000);
    if (msg.type === 'terminated') {
      return { terminated: msg.terminated, survivors: msg.survivors || [], error: msg.error };
    }
    throw new Error(`Unexpected terminate response: ${JSON.stringify(msg)}`);
  }

  /**
   * Close the context and kill the helper process.
   */
  close() {
    if (this._closed) return;
    this._closed = true;
    this._rejectAll(new Error('Context closed'));
    if (this._process && !this._process.killed) {
      try { this._process.stdin.end(); } catch {}
      setTimeout(() => {
        try { if (!this._process.killed) this._process.kill(); } catch {}
      }, 100).unref();
    }
    this._process = null;
  }
}

// NOTE — there is deliberately no pid-based `terminateTree(pid)` here.
//
// The native helper's protocol has exactly two commands, `spawn` and `terminate`
// (native/windows-job-helper/Program.cs, the switch at HandleCommand), and `terminate`
// acts only on the Job Object that THIS helper instance created in its own `spawn`.
// A freshly launched helper has `_jobHandle == IntPtr.Zero` and answers
// `{"type":"error","error":"no active job"}` — it cannot adopt an already-running tree,
// because a Windows Job Object cannot retroactively adopt one.
//
// So a pid-based tree kill is not implementable against today's helper, and an
// implementation that appears to work is worse than none: the version removed here
// spawned the helper with the pid as argv (which the helper never reads), then
// resolved `{terminated: true}` off the helper's exit code after the helper had
// already answered with an error — reporting a successful kill having killed nothing.
// That is AGENTS.md Mistake #5 exactly.
//
// The debt-free fix is for adapters to spawn the backend THROUGH a ContainmentContext
// so the tree is contained from birth; then `context.terminate()` above is all the
// worker's hard timeout needs. See docs/tickets/78.
// `tests/core/hard-kill-honesty.test.js` pins the absence of this export.

module.exports = { ContainmentContext, isAvailable, resolveHelperPath, HELPER_PATH };
