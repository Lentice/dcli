const KNOWN_BACKENDS = new Set(['opencode', 'codex', 'claude', 'fake']);
const DEFAULT_BACKEND = 'fake';

const entries = {
  opencode: { module: 'adapters/opencode/adapter', class: 'OpencodeAdapter', admissionLimit: 3 },
  codex:    { module: 'adapters/codex/adapter',    class: 'CodexAdapter',    admissionLimit: 3 },
  claude:   { module: 'adapters/claude/adapter',   class: 'ClaudeAdapter',   admissionLimit: 3 },
  fake:     { module: 'adapters/fake/adapter',     class: 'FakeAdapter',     admissionLimit: 3 },
};

function getBackground(backendName) {
  const entry = entries[backendName];
  if (!entry) throw new Error(`Unknown backend: ${backendName}`);
  return entry;
}

function getBackendLimits() {
  const limits = {};
  for (const [name, entry] of Object.entries(entries)) {
    limits[name] = entry.admissionLimit;
  }
  return limits;
}

module.exports = { entries, KNOWN_BACKENDS, DEFAULT_BACKEND, getBackground, getBackendLimits };
