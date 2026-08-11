/**
 * Lifecycle methods shared verbatim by the codex and claude adapters.
 *
 * Both adapters drive a single spawned child that streams line-delimited
 * events on stdout, so their wait/wake/cancel/recover halves were identical
 * character for character. They live here once; `applyProcessLifecycle`
 * copies them onto an adapter prototype.
 *
 * This is NOT a backend abstraction — it is deduplication of two identical
 * bodies. An adapter that needs different behaviour overrides the method on
 * its own class (opencode does not use this at all; it drives an HTTP server,
 * not a stdout stream).
 *
 * Required instance fields: _facts, _liveFactsResolve, _exitResolve,
 * _observedExited, _childProcess, _cancelled, _cancelRungReached,
 * _stdoutClosed, _stderrClosed, _drainTimedOut.
 */
const { spawn } = require('node:child_process');

// How long between the SIGTERM and the SIGKILL when terminating a contained
// process group (Unix rung 1, ADR-010). Finite by construction (invariant 3:
// nothing waits forever). A backend normally exits well within this.
const PROCESS_GROUP_GRACE_MS = 5000;

/**
 * Terminate a backend child and everything it spawned.
 *
 * Unix (rung 1, ADR-010): the child was spawned `detached`, so it is the
 * leader of a process group whose id is the child's pid and which contains
 * only its descendants. A negative pid signals the whole group. This is the
 * one signal that IS ownership proof, not the "unverified reused pid" the
 * spec forbids: the group was created by this very spawn, so its id cannot
 * name a group we do not own. `SIGTERM` → bounded grace → `SIGKILL` to the
 * group; `ESRCH` from either signal means the group is already gone, which is
 * the outcome we wanted, not an error.
 *
 * Windows (rung 0): today's direct-child `kill('SIGKILL')`, copied verbatim —
 * `detached` means a new console there, not a group, so a negative pid would
 * be meaningless (ticket 103 raises this half).
 *
 * POSIX callers must only pass a child they spawned `detached`: a negative
 * pid built from a non-detached child would target a group we do not own.
 *
 * @param {object|null} child
 * @param {{ graceMs?: number }} [opts]
 * @returns {Promise<{ kind: 'process-group'|'none', degraded: boolean, escalated: boolean }>}
 */
async function terminateProcessTree(child, { graceMs = PROCESS_GROUP_GRACE_MS } = {}) {
  if (process.platform === 'win32') {
    if (child && !child.killed) {
      try { child.kill('SIGKILL'); } catch {
        try { child.kill(); } catch {}
      }
    }
    return { kind: 'none', degraded: true, escalated: false };
  }

  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
    return { kind: 'none', degraded: true, escalated: false };
  }

  const pgid = child.pid;
  const signalGroup = (signal) => {
    try {
      process.kill(-pgid, signal);
      return true;
    } catch (err) {
      if (err && err.code === 'ESRCH') return true;
      return false;
    }
  };

  signalGroup('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    await new Promise(r => setTimeout(r, 50));
  }
  let escalated = false;
  if (child.exitCode === null && child.signalCode === null) {
    escalated = signalGroup('SIGKILL');
  }
  return { kind: 'process-group', degraded: false, escalated };
}

/**
 * The containment record for a backend this process spawned. POSIX: the
 * spawn is `detached`, the group is owned — rung 1, a full guarantee.
 * Windows: no containment (rung 0); the driver records `kill_skipped` there
 * instead, so nothing is written here.
 *
 * @returns {{ kind: 'process-group', degraded: false }|undefined}
 */
function containmentRecordForThisSpawn() {
  if (process.platform === 'win32') return undefined;
  return { kind: 'process-group', degraded: false };
}

// How often a parked live-fact drain re-checks its own terminal condition.
// This bound is not a performance knob: the timer behind it is the only refed
// libuv handle that exists while the drain is parked and the child has closed
// its pipes, so it is what stops the process from silently exiting 0 mid-drain.
// See _waitForFactsOrRecheck and the bounded observe-wakeup regression test.
const LIVE_DRAIN_RECHECK_MS = 250;
const POST_EXIT_DRAIN_MS = 3000;

const methods = {
  /**
   * The one seam at the process boundary. A test overrides this on the adapter
   * instance with a scripted fake child (an EventEmitter carrying stdout/stderr
   * streams, a pid and a kill()) so that everything downstream — stream
   * framing, the drain, exit ordering, fact classification — runs for real.
   * The default is the adapter's own spawn call: the options the adapter
   * assembled in Start() are handed through verbatim, never re-derived here.
   *
   * @param {{ command: string, args: string[], options: object }} invocation
   * @returns {import('node:child_process').ChildProcess}
   */
  _spawn(invocation) {
    return spawn(invocation.command, invocation.args, invocation.options);
  },

  DeclareCancelRungs() {
    return ['hard_kill'];
  },

  PrepareInvocation(attempt, request) {
    this._lastRequest = request ? { ...request } : this._lastRequest;
  },

  /**
   * Park until new facts arrive OR the re-check interval elapses.
   *
   * The timeout is the load-bearing half. A wait that only resolves when
   * someone remembers to wake it is a hang the moment one wake-up path is
   * missed, and a bare promise refs no libuv handle, so "await forever"
   * degrades to a silent exit 0 rather than a visible stall. A dropped
   * wake-up must cost one re-check interval of delay, never a hang and never
   * process evaporation.
   *
   * @returns {Promise<void>}
   */
  _waitForFactsOrRecheck() {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this._liveFactsResolve === done) this._liveFactsResolve = null;
        resolve();
      };
      const timer = setTimeout(done, LIVE_DRAIN_RECHECK_MS);
      this._liveFactsResolve = done;
    });
  },

  /**
   * Wake the live-fact drain. Called whenever stdout produced new facts.
   */
  _wakeFactWaiter() {
    if (this._liveFactsResolve) {
      const r = this._liveFactsResolve;
      this._liveFactsResolve = null;
      r();
    }
  },

  /**
   * Wake every waiter after the child has terminated. Both terminal handlers
   * call this single method on purpose: the defect it fixes was one terminal
   * handler waking one of two waiters, so a future third waiter must not be
   * something a handler can forget.
   */
  _wakeObservers() {
    this._wakeFactWaiter();
    if (this._exitResolve) {
      const r = this._exitResolve;
      this._exitResolve = null;
      r();
    }
  },

  /**
   * Resolve once the child has exited or errored (per the 'exit'/'error'
   * handlers registered in Start(), which set `_observedExited` and call
   * `_wakeObservers`).
   *
   * This is a bare promise, and a bare promise refs NOTHING. What keeps the
   * event loop alive is the child's own pipe and process handles while they
   * are open, and the refed re-check timer in `_waitForFactsOrRecheck` once
   * they are not. Reaching here normally means the live drain already
   * observed termination, so it resolves immediately; the pending path only
   * matters on a race. No internal timeout — the caller (executeRun) owns the
   * hard-timeout bound via RequestCancel, which triggers a real process exit
   * and unblocks this.
   *
   * @returns {Promise<void>}
   */
  _waitForExit() {
    if (this._observedExited) return Promise.resolve();
    return new Promise((resolve) => {
      this._exitResolve = resolve;
    });
  },

  async RequestCancel(attempt, rung) {
    if (this._cancelled) return { success: true };

    if (rung !== 'hard_kill') {
      return { success: false, error: `Unknown rung: ${rung}` };
    }

    // The rung now terminates the group on Unix and the direct child on
    // Windows (terminateProcessTree); `hard_kill` therefore keeps its
    // promise on POSIX (ADR-010 rung 1) and stays the honest rung 0 record
    // on Windows.
    if (this._childProcess) {
      await terminateProcessTree(this._childProcess);
    }

    this._cancelRungReached = 'hard_kill';
    this._cancelled = true;
    return { success: true };
  },

  _resolveExitCode() {
    const facts = this._facts || [];
    for (let i = facts.length - 1; i >= 0; i--) {
      if (facts[i].type === 'process_exited') {
        return facts[i].code !== undefined ? facts[i].code : null;
      }
    }
    return null;
  },

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
  },

  async _waitForStreamDrain() {
    if (this._stdoutClosed && this._stderrClosed) return;
    const deadline = Date.now() + POST_EXIT_DRAIN_MS;
    while (Date.now() < deadline) {
      if (this._stdoutClosed && this._stderrClosed) return;
      await new Promise(r => setTimeout(r, 10));
    }
    this._drainTimedOut = true;
    this._facts.push({ type: 'drain_timeout', message: 'stdout/stderr did not close within POST_EXIT_DRAIN_MS' });
  },

  /**
   * Yield the accumulated terminal facts with `process_exited` LAST.
   *
   * The engine stops consuming the moment it sees `process_exited` — that fact
   * is what ends the attempt — so anything appended after it in `_facts` is
   * never delivered. `_classifyStderrFailure` appends exactly there, which is
   * how a quota or authentication failure reached the journal as an
   * unexplained exit 1: the classification existed and was simply never read.
   */
  *_orderedTerminalFacts() {
    const facts = this._facts || [];
    for (const fact of facts) {
      if (fact && fact.type === 'process_exited') continue;
      yield { ...fact };
    }
    for (const fact of facts) {
      if (fact && fact.type === 'process_exited') yield { ...fact };
    }
  },

  _classifyStderrFailure() {
    if (!this._stderrContent) return;
    const existingError = this._facts.find(f => f && f.type === 'backend_error');
    if (existingError && existingError.class_hint !== 'execution_error') return;
    const exited = this._facts.find(f => f && f.type === 'process_exited');
    if (!exited || exited.code === 0) return;

    const signals = [
      [/quota|rate[ -]?limit|too many requests|credits|usage limit|insufficient funds/i, 'quota_or_rate_limit'],
      [/unauthori[sz]ed|authentication|invalid (?:api )?key|login required|token expired/i, 'authentication'],
      [/permission denied|access denied|sandbox/i, 'permission_or_sandbox'],
      [/connection refused|connection reset|unable to connect|network error/i, 'network_error'],
    ];
    for (const [pattern, classHint] of signals) {
      if (pattern.test(this._stderrContent)) {
        // Persist only a fixed classification, never provider stderr (which
        // may contain credentials or request data).
        if (existingError) {
          existingError.class_hint = classHint;
          existingError.structured_payload = { reason: classHint };
        } else {
          this._facts.push({ type: 'backend_error', class_hint: classHint, structured_payload: { reason: classHint } });
        }
        return;
      }
    }
  },
};

/**
 * @param {Function} AdapterClass
 */
function applyProcessLifecycle(AdapterClass) {
  for (const [name, fn] of Object.entries(methods)) {
    if (!Object.prototype.hasOwnProperty.call(AdapterClass.prototype, name)) {
      AdapterClass.prototype[name] = fn;
    }
  }
  return AdapterClass;
}

module.exports = { applyProcessLifecycle, terminateProcessTree, containmentRecordForThisSpawn, LIVE_DRAIN_RECHECK_MS, POST_EXIT_DRAIN_MS };
