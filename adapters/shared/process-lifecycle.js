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
 * _stdoutClosed, _stderrClosed, _drainTimedOut, _mockExitCode.
 */

// How often a parked live-fact drain re-checks its own terminal condition.
// This bound is not a performance knob: the timer behind it is the only refed
// libuv handle that exists while the drain is parked and the child has closed
// its pipes, so it is what stops the process from silently exiting 0 mid-drain.
// See _waitForFactsOrRecheck and docs/tickets/79.
const LIVE_DRAIN_RECHECK_MS = 250;
const POST_EXIT_DRAIN_MS = 3000;

const methods = {
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
  },

  _resolveExitCode() {
    if (this._mockExitCode !== null) return this._mockExitCode;
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

module.exports = { applyProcessLifecycle, LIVE_DRAIN_RECHECK_MS, POST_EXIT_DRAIN_MS };
