const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
const { buildCmdInvocation } = require('../codex/cmd-quoting');
const { getRedactor } = require('../../core/fs-text');
const { terminateProcessTree } = require('../shared/process-lifecycle');
const { HttpTransport, requestJson } = require('./transport');

const PORT_RESERVE_MAX_RETRIES = 5;
const PORT_RESERVE_TIMEOUT_MS = 5000;
const STARTUP_TIMEOUT_MS = 30000;
const HEALTH_TIMEOUT_MS = 10000;
const DISPOSE_TIMEOUT_MS = 5000;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_BYTES = 10 * 1024 * 1024;

/**
 * One `opencode serve` process per job (ADR-002 — never pooled, never shared).
 *
 * Owns process launch, readiness (port from startup output, confirmed with
 * GET /global/health), the random per-job password, stdout/stderr capture,
 * and the `<state-root>/servers/<job-id>.json` metadata that makes a crashed
 * wrapper's servers findable. Exposes `request` / `events` over its transport
 * so the rest of the adapter never sees a socket.
 *
 * Every HTTP call it makes carries an AbortController bound (invariant 3).
 */
class OpencodeServer {
  /**
   * @param {{ stateRoot?: string|null, jobId?: string|null }} opts
   */
  constructor({ stateRoot = null, jobId = null } = {}) {
    this._stateRoot = stateRoot;
    this._jobId = jobId;
    this._serversDir = stateRoot ? path.join(stateRoot, 'servers') : null;

    this._process = null;
    this._password = null;
    this._port = null;
    this._baseUrl = null;
    this._transport = null;
    this._creationTime = null;
    this._imagePath = null;
    this._executionToken = null;
    this._stdout = '';
    this._stderr = '';
    this._disposed = false;

    this._startupTimeoutMs = STARTUP_TIMEOUT_MS;
    this._healthTimeoutMs = HEALTH_TIMEOUT_MS;
    this._maxStdoutBytes = MAX_STDOUT_BYTES;
    this._maxStderrBytes = MAX_STDERR_BYTES;
  }

  get process() { return this._process; }
  get pid() { return this._process ? this._process.pid : null; }
  get password() { return this._password; }
  get port() { return this._port; }
  get baseUrl() { return this._baseUrl; }
  get transport() { return this._transport; }
  get creationTime() { return this._creationTime; }
  get imagePath() { return this._imagePath; }
  get executionToken() { return this._executionToken; }
  get stdout() { return this._stdout; }
  get stderr() { return this._stderr; }
  get disposed() { return this._disposed; }
  get startupTimeoutMs() { return this._startupTimeoutMs; }
  get healthTimeoutMs() { return this._healthTimeoutMs; }

  /**
   * Launch the server and wait until it is healthy.
   *
   * @param {{ canonicalDir?: string|null, opencodePath: string }} opts
   * @returns {Promise<{ serverPid: number, port: number, version: string }>}
   */
  async start({ canonicalDir = null, opencodePath }) {
    if (this._disposed) throw new Error('Server already disposed');
    if (this._process) throw new Error('Server already started');

    this._password = this._generatePassword();
    this._registerPasswordWithRedactor();

    const port = await OpencodeServer.reservePort();
    const args = OpencodeServer.buildArgs(port);

    const invocation = buildCmdInvocation({
      command: opencodePath,
      args,
      cwd: canonicalDir || undefined,
    });

    const server = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: this._password },
      windowsHide: invocation.windowsHide,
      // POSIX only. `detached: true` calls setsid(2), putting the child in a
      // new process group whose pgid is the child's pid, so every descendant
      // it spawns (watchers, providers, git) is in that group and can be
      // signalled as a unit. On Windows `detached` means a new console
      // instead, which is not containment and would defeat windowsHide — see
      // docs/engineering/windows-spawning.md. Never unref() this child; dcli
      // waits on its exit.
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });

    this._process = server;
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
      this._appendStdout(chunk);
      const boundPort = OpencodeServer.parseStartupOutput(this._stdout);
      if (boundPort !== null) {
        clearTimeout(startupTimer);
        startupResolve(boundPort);
      }
    });

    server.stderr.on('data', (chunk) => {
      this._appendStderr(chunk);
    });

    server.on('exit', (code, signal) => {
      if (this._port === null) {
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
      this.kill();
      throw err;
    }

    if (resolvedPort !== port) {
      this.kill();
      throw new Error(`Server bound on port ${resolvedPort} but was launched on port ${port}`);
    }

    this._port = resolvedPort;
    this._baseUrl = `http://127.0.0.1:${resolvedPort}`;
    this._transport = new HttpTransport({ baseUrl: this._baseUrl, password: this._password });

    try {
      const health = await requestJson(this._transport, {
        method: 'GET',
        path: '/global/health',
        timeoutMs: this._healthTimeoutMs,
      });
      if (!health || !health.healthy) {
        throw new Error(`Server health check failed: version=${health ? health.version : 'unknown'}`);
      }
    } catch (err) {
      this.kill();
      throw err;
    }

    this._writeServerMetadata(resolvedPort, this._executionToken);

    return {
      serverPid: server.pid,
      port: resolvedPort,
      version: 'unknown',
    };
  }

  /**
   * One bounded request against this server, parsed-JSON semantics.
   */
  request({ method, path: endpoint, body, timeoutMs }) {
    if (!this._transport) throw new Error('Server not started');
    return requestJson(this._transport, { method, path: endpoint, body, timeoutMs });
  }

  /**
   * The SSE source for this server.
   */
  events(path, { signal }) {
    if (!this._transport) throw new Error('Server not started');
    return this._transport.events(path, { signal });
  }

  /**
   * Graceful teardown: bounded POST /global/dispose (best-effort), kill the
   * process tree, delete the metadata record. Idempotent.
   *
   * @returns {Promise<{ gracefulPost: 'ok'|'failed' }>}
   */
  async dispose() {
    if (this._disposed) return { gracefulPost: 'ok' };
    this._disposed = true;

    let gracefulPost = 'ok';
    if (this._transport) {
      try {
        await requestJson(this._transport, {
          method: 'POST',
          path: '/global/dispose',
          body: {},
          timeoutMs: DISPOSE_TIMEOUT_MS,
        });
      } catch {
        gracefulPost = 'failed';
      }
    }

    await this.kill();
    this._deleteServerMetadata();
    this._process = null;
    this._baseUrl = null;
    this._port = null;
    this._transport = null;
    return { gracefulPost };
  }

  async kill() {
    if (!this._process) return;
    // The Windows Bun shim spawns the real server as a child; ChildProcess.kill()
    // only reaches the shim, so terminate the whole tree first.
    if (process.platform === 'win32' && !this._process.killed && this._process.exitCode === null &&
      Number.isInteger(this._process.pid) && this._process.pid > 0) {
      try {
        spawnSync('taskkill', ['/PID', String(this._process.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 5000,
        });
      } catch {}
    }
    // Terminates the process group on Unix (ADR-010 rung 1) and the direct
    // child on Windows, exactly as the shared hard_kill rung does.
    await terminateProcessTree(this._process);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  static buildArgs(port) {
    return ['serve', '--port', String(port), '--hostname', '127.0.0.1'];
  }

  static parseStartupOutput(text) {
    const match = text.match(/opencode server listening on http:\/\/[^:]+:(\d+)/);
    if (match) return parseInt(match[1], 10);
    return null;
  }

  static async reservePort(maxRetries) {
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

  static generatePassword() {
    return 'dcli_' + crypto.randomBytes(24).toString('hex');
  }

  static discoverOrphaned(stateRoot) {
    const serversDir = stateRoot ? path.join(stateRoot, 'servers') : null;
    if (!serversDir || !fs.existsSync(serversDir)) return [];
    const results = [];
    try {
      const entries = fs.readdirSync(serversDir);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          const content = fs.readFileSync(path.join(serversDir, entry), 'utf8');
          const meta = JSON.parse(content);
          results.push({ jobId: entry.replace('.json', ''), ...meta });
        } catch {}
      }
    } catch {}
    return results;
  }

  _generatePassword() {
    return OpencodeServer.generatePassword();
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
      pid: this.pid,
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

  _appendStdout(chunk) {
    if (typeof chunk === 'string') {
      if (this._stdout.length < this._maxStdoutBytes) {
        this._stdout += chunk;
        if (this._stdout.length > this._maxStdoutBytes) {
          this._stdout = this._stdout.slice(0, this._maxStdoutBytes);
        }
      }
    }
  }

  _appendStderr(chunk) {
    if (typeof chunk === 'string') {
      if (this._stderr.length < this._maxStderrBytes) {
        this._stderr += chunk;
        if (this._stderr.length > this._maxStderrBytes) {
          this._stderr = this._stderr.slice(0, this._maxStderrBytes);
        }
      }
    }
  }
}

module.exports = { OpencodeServer };
