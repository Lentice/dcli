const SMOKE_PROMPT = 'Reply with exactly one short word: PONG';

/**
 * Run the smallest real request supported by every adapter.
 *
 * @param {Object} adapter
 * @param {string} repoPath
 * @returns {Promise<{text:string, prompt:string}>}
 */
async function runAdapterSmoke(adapter, repoPath) {
  const attempt = {};
  const request = {
    canonicalDir: repoPath || process.cwd(),
    access: 'read-only',
  };
  const facts = [];

  try {
    adapter.ValidateRequest(request);
    if (typeof adapter.PrepareInvocation === 'function') {
      adapter.PrepareInvocation(attempt, request);
    }
    await adapter.Start(attempt);
    await adapter.SendPrompt(attempt, SMOKE_PROMPT);
    for await (const fact of adapter.Observe(attempt)) {
      facts.push(fact);
    }

    const backendError = facts.find(fact => fact && fact.type === 'backend_error');
    if (backendError) {
      const err = new Error(`Backend emitted ${backendError.class_hint || 'an execution error'} before answering`);
      err.classHint = backendError.class_hint || 'execution_error';
      throw err;
    }

    const result = await adapter.CollectResult(attempt);
    const text = result && typeof result.text === 'string' ? result.text.trim() : '';
    if (!text) {
      const err = new Error('Backend completed without a response');
      err.classHint = 'execution_error';
      throw err;
    }
    return { text, prompt: SMOKE_PROMPT };
  } finally {
    await adapter.Dispose(attempt);
  }
}

module.exports = { SMOKE_PROMPT, runAdapterSmoke };
