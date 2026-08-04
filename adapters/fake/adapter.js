// The default script is what `dcli --backend fake <command>` runs on: a single
// successful turn. It lives here, with the fake, rather than in the CLI entry
// point, so no real adapter is ever constructed with scripted fixtures.
function DEFAULT_FACTS() {
  return [
    { type: 'started', backend_pid: 1, backend_session_id: 'ses_default' },
    { type: 'assistant_text', message_id: 'm1', text: 'Hello from dcli' },
    { type: 'usage_reported', tokens: { input: 10, output: 20, total: 30 } },
    { type: 'process_exited', code: 0 },
  ];
}

function DEFAULT_CAPABILITIES() {
  return {
    schema_version: 1,
    backend: 'fake',
    backend_version: '1.0.0',
    core: { run: true, submit: true, resume: true, cancel: true, wrapper_worktree: true },
    extensions: {},
  };
}

class FakeAdapter {
  constructor(script) {
    this._script = {
      facts: DEFAULT_FACTS(),
      exitCode: 0,
      declaredRungs: ['hard_kill'],
      capabilities: DEFAULT_CAPABILITIES(),
      behaviors: {},
      rungFailures: {},
      detectedVersion: '1.0.0',
      ...script,
    };
    this._cancelled = false;
    this._cancelRungReached = null;
    this._disposed = false;
    this._responses = [];
    this._lastPrompt = null;
  }

  get script() { return this._script; }
  get cancelled() { return this._cancelled; }
  get cancelRungReached() { return this._cancelRungReached; }
  get disposed() { return this._disposed; }
  get responses() { return this._responses; }
  get lastPrompt() { return this._lastPrompt; }

  GetIdentity() {
    return {
      backend: 'fake',
      adapter_version: '1.0.0',
      state_schema_version: 1,
    };
  }

  DetectVersion() {
    return this._script.detectedVersion || '1.0.0';
  }

  ProbeCapabilities() {
    return JSON.parse(JSON.stringify(this._script.capabilities));
  }

  DeclareCancelRungs() {
    return [...this._script.declaredRungs];
  }

  ValidateRequest(request) {
    if (!request || typeof request !== 'object') return;

    const failOn = this._script.behaviors.failValidateOn;
    if (failOn && request[failOn] !== undefined) {
      const err = this._buildValidationError(failOn, request[failOn]);
      throw err;
    }

    const unsupportedByDefault = ['reasoningEffort'];
    for (const key of unsupportedByDefault) {
      if (request[key] !== undefined && request[key] !== null && key !== failOn) {
        if (!this._script.behaviors.allowedOptions || !this._script.behaviors.allowedOptions.includes(key)) {
          const err = this._buildValidationError(key, request[key]);
          throw err;
        }
      }
    }
  }

  _buildValidationError(optionKey, optionValue) {
    const flagName = optionKey.replace(/([A-Z])/g, '-$1').toLowerCase();
    const err = new Error(
      `--${flagName} is not supported by backend ${this._script.capabilities.backend || 'fake'}. ` +
      `Use --variant <provider-specific-value>. ` +
      `Run '${this._script.capabilities.backend || 'fake'} capabilities --json' for the current surface. ` +
      `No job was created.`
    );
    err.code = 'VALIDATION_FAILED';
    err.failureClass = 'unsupported_capability';
    err.optionName = `--${flagName}`;
    err.backendName = this._script.capabilities.backend || 'fake';
    return err;
  }

  PrepareInvocation(attempt, request) {
    if (this._script.behaviors && typeof this._script.behaviors.onStart === 'function') {
      this._script.behaviors.onStart(attempt, request);
    }
  }

  Start(attempt) {
    return { handle: 'fake-handle' };
  }

  async *Observe(attempt) {
    const facts = this._script.facts;
    const hangAfter = this._script.behaviors.hangAfter;
    for (let i = 0; i < facts.length; i++) {
      if (this._cancelled) break;
      const fact = facts[i];
      if (fact.delayMs && fact.delayMs > 0) {
        await this._interruptibleSleep(fact.delayMs);
      }
      if (this._cancelled) break;
      const { delayMs, ...factData } = fact;
      yield { ...factData };
      if (hangAfter && fact.type === hangAfter) {
        if (this._script.behaviors && this._script.behaviors.hangForever) {
          await this._foreverWait();
        } else {
          await this._interruptibleWait();
        }
        break;
      }
    }
  }

  SendPrompt(attempt, prompt) {
    this._lastPrompt = prompt;
  }

  Resume(attempt, kind, prompt) {
    this._lastPrompt = prompt;
  }

  Respond(interactionId, decision) {
    const caps = this._script.capabilities;
    if (!caps.extensions || !caps.extensions.interactive_permissions || !caps.extensions.interactive_permissions.supported) {
      throw new Error('Respond is not supported: interactive_permissions capability not declared');
    }
    this._responses.push({ interactionId, decision });
  }

  RequestCancel(attempt, rung) {
    const rungFailures = this._script.rungFailures;
    if (rungFailures && rungFailures[rung]) {
      return { success: false, error: `Rung "${rung}" failed as configured` };
    }
    this._cancelRungReached = rung;
    this._cancelled = true;
    if (this._script.behaviors && typeof this._script.behaviors.onCancel === 'function') {
      this._script.behaviors.onCancel(rung);
    }
    return { success: true };
  }

  CollectResult(attempt) {
    const facts = this._script.facts;
    let lastText = '';
    let usage = { input: 0, output: 0, total: 0 };
    let backendSessionId = null;
    for (const f of facts) {
      if (f.type === 'assistant_text') lastText = f.text;
      if (f.type === 'usage_reported' && f.tokens) usage = { ...f.tokens };
      if (f.type === 'started' && f.backend_session_id) backendSessionId = f.backend_session_id;
    }
    return {
      text: lastText,
      usage,
      backend_session_id: backendSessionId,
    };
  }

  CollectDiagnostics(attempt) {
    return {
      schema_version: 1,
      backend: 'fake',
      facts_emitted: this._script.facts.length,
      exit_code: this._script.exitCode,
    };
  }

  Dispose(attempt) {
    this._disposed = true;
  }

  Recover(attempt) {
    if (this._cancelled) return { state: 'cancelled' };
    if (this._script.behaviors.hangAfter) return { state: 'interrupted' };
    const facts = this._script.facts || [];
    const processExited = facts.find(f => f && f.type === 'process_exited');
    if (processExited) {
      return { state: processExited.code === 0 ? 'done' : 'failed' };
    }
    const backendError = facts.find(f => f && f.type === 'backend_error');
    if (backendError) return { state: 'failed' };
    return { state: 'interrupted' };
  }

  async LiveSmoke(timeoutMs) {
    const wait = this._script.behaviors && this._script.behaviors.liveSmokeWaitMs;
    if (wait) {
      await this._interruptibleSleep(wait);
    }
    if (this._script.behaviors && this._script.behaviors.liveSmokeFail) {
      throw new Error(this._script.behaviors.liveSmokeFail);
    }
  }

  async _interruptibleSleep(ms) {
    const step = 50;
    while (ms > 0) {
      if (this._cancelled || this._disposed) return;
      await new Promise(r => setTimeout(r, Math.min(step, ms)));
      ms -= step;
    }
  }

  async _interruptibleWait() {
    while (!this._cancelled) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  async _foreverWait() {
    while (true) {
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

module.exports = { FakeAdapter };
