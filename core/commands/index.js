const { generateJobId } = require('../job-id');
const { resolveDeadline } = require('../deadlines');

const KNOWN_FLAGS = new Set([
  '--backend', '--repo', '--prompt-file', '--hard-timeout-sec', '--group', '--label',
  '--model', '--json', '--timeout-sec', '--all', '--help',
  '--older-than', '--dry-run', '--scrub-session-ids', '--max-bytes',
  '--reasoning-effort', '--variant', '--effort', '--live-smoke-timeout-sec',
  '--access', '--mode',
  '--staged', '--working', '--range', '--path', '--include-untracked',
  '--embed-diff', '--intent', '--focus',
  '--stat', '--name-only',
  '--reset-author', '--message', '--allow-untracked',
  '--kind', '--resume',
]);

const COMMANDS = new Set(['run', 'submit', 'status', 'wait', 'read', 'list', 'cancel', 'review', 'resume', 'tail', 'debug', 'cleanup', 'capabilities', 'doctor', 'diff', 'apply']);

const { KNOWN_BACKENDS, getBackendLimits } = require('../../adapters/registry');

// Threshold below which a non-zero-exit result is treated as "no usable
// result produced" (the backend emitted only a few dozen bytes of
// "I'll dispatch..." boilerplate before exiting 1). Conservative: every real review/analysis result observed in
// production is well above this size.
const NO_RESULT_BYTE_THRESHOLD = 512;

// Advisory patterns for prompts that ask for tool dispatch a read-only job
// cannot satisfy (subagent / Task tool / file writes). Conservative — only
// verb-led constructions of the direct object ("dispatch a subagent",
// "use the Task tool", "write a file") trigger, not bare nouns.
const ACCESS_HINT_PATTERNS = [
  /\b(?:dispatch|spawn|launch|use|invoke|call)\s+(?:a\s+|the\s+|some\s+)?sub-?agent\b/i,
  /\b(?:dispatch|spawn|launch)\s+(?:a\s+|the\s+)?agent\b/i,
  /\btask\s+tool\b/i,
  /\b(?:write|create|edit|modify|delete|remove)\s+(?:a\s+|the\s+|some\s+)?file\b/i,
];

/**
 * Derive the journal-ready failure_reason / failure for a terminal attempt
 * from the reducer's projection plus a byte-size heuristic. When the reducer
 * already supplied a failure_reason (e.g. 'hard_timeout'), it is preserved —
 * the no-result heuristic only fills in for otherwise-unexplained non-zero
 * exits with an unusably small result.
 *
 * @param {{ exitCode:number|null, resultBytes:number, reducerResult:Object }} args
 * @returns {{ failure_reason:string|null, failure:Object|null }}
 */
function classifyTerminalFailure({ exitCode, resultBytes, reducerResult }) {
  const failure_reason = (reducerResult && reducerResult.failure_reason) || null;
  const failure = (reducerResult && reducerResult.failure) || null;
  if (exitCode && exitCode !== 0 &&
      typeof resultBytes === 'number' && resultBytes < NO_RESULT_BYTE_THRESHOLD) {
    if (!failure_reason) return { failure_reason: 'backend_exited_no_result', failure };
  }
  return { failure_reason, failure };
}

/**
 * Cheap advisory check: if no --access was supplied (default is read-only) and
 * the prompt asks for subagent dispatch / file writes / the Task tool, emit a
 * hint pointing at --access workspace. Never blocks the run.
 *
 * @param {{ access:string|null, prompt:string|null }} args
 * @returns {string|null} hint message, or null if no advice applies
 */
function maybeAccessHint({ access, prompt }) {
  const effectiveAccess = access || 'read-only';
  if (effectiveAccess !== 'read-only') return null;
  if (!prompt || typeof prompt !== 'string') return null;
  for (const re of ACCESS_HINT_PATTERNS) {
    if (re.test(prompt)) {
      return 'hint: --access read-only forbids subagent / write tools; --access workspace may be needed for this task.';
    }
  }
  return null;
}

function buildEnvelope(status) {
  return {
    schema_version: 1,
    job_id: status.job_id || null,
    backend: status.backend || null,
    state: status.state || 'created',
    phase: status.phase || null,
    attempt: status.attempt !== undefined && status.attempt !== null ? status.attempt : null,
    command_exit_code: status.command_exit_code !== undefined ? status.command_exit_code : null,
    backend_exit_code: status.backend_exit_code !== undefined ? status.backend_exit_code : null,
    failure_reason: status.failure_reason || null,
    failure: status.failure || null,
    findings: null,
    findings_status: status.findings_status || null,
    truncation_info: null,
    untracked_warning: null,
  };
}

// Valueless flags: token -> result key set to true.
const BOOL_FLAGS = {
  '--json': 'json',
  '--all': 'waitAll',
  '--dry-run': 'dryRun',
  '--scrub-session-ids': 'scrubSessionIds',
  '--staged': 'staged',
  '--working': 'working',
  '--include-untracked': 'includeUntracked',
  '--embed-diff': 'embedDiff',
  '--stat': 'stat',
  '--name-only': 'nameOnly',
  '--reset-author': 'resetAuthor',
  '--allow-untracked': 'allowUntracked',
};

// Flags that consume the next argv token. A flag here missing its value is a
// hard error — never silently accepted.
const VALUE_FLAGS = new Set(['--backend', '--repo', '--prompt-file', '--hard-timeout-sec',
  '--group', '--label', '--model', '--timeout-sec', '--older-than', '--max-bytes',
  '--reasoning-effort', '--variant', '--effort', '--live-smoke-timeout-sec',
  '--access', '--range', '--path', '--intent', '--focus',
  '--message', '--mode', '--kind', '--resume']);

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    command: null,
    backend: null,
    repo: null,
    promptFile: null,
    hardTimeoutSec: null,
    group: null,
    label: null,
    model: null,
    access: null,
    json: false,
    timeoutSec: null,
    waitAll: false,
    help: false,
    positionals: [],
    unknown: [],
  };

  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === '--help') {
      result.help = true;
      i++;
      continue;
    }

    if (arg.startsWith('--')) {
      const boolKey = BOOL_FLAGS[arg];
      if (boolKey) {
        result[boolKey] = true;
        i++;
        continue;
      }

      if (VALUE_FLAGS.has(arg)) {
        i++;
        if (i >= args.length || args[i].startsWith('--')) {
          const err = new Error(`Flag ${arg} requires a value`);
          err.exitCode = 2;
          throw err;
        }
        const val = args[i];
        switch (arg) {
          case '--backend':
            if (!KNOWN_BACKENDS.has(val)) {
              const err = new Error(`Unknown backend "${val}". Must be one of: ${[...KNOWN_BACKENDS].join(', ')}`);
              err.exitCode = 2;
              throw err;
            }
            if (result.backend !== null) {
              const err = new Error(`--backend set twice: was "${result.backend}", got "${val}". Only one backend may be specified.`);
              err.exitCode = 2;
              throw err;
            }
            result.backend = val;
            break;
          case '--repo': result.repo = val; break;
          case '--prompt-file': result.promptFile = val; break;
          case '--hard-timeout-sec':
            result.hardTimeoutSec = parseInt(val, 10);
            if (isNaN(result.hardTimeoutSec) || result.hardTimeoutSec <= 0) {
              const err = new Error(`Invalid --hard-timeout-sec: "${val}" must be a positive integer`);
              err.exitCode = 2;
              throw err;
            }
            break;
          case '--group': result.group = val; break;
          case '--label': result.label = val; break;
          case '--model': result.model = val; break;
          case '--older-than':
            if (!/^\d+[dh]$/.test(val)) {
              const err = new Error(`Invalid --older-than format: "${val}". Use e.g. "30d" or "12h"`);
              err.exitCode = 2;
              throw err;
            }
            const ageNum = parseInt(val, 10);
            if (ageNum < 1) {
              const err = new Error(`--older-than value must be at least 1, got "${val}"`);
              err.exitCode = 2;
              throw err;
            }
            result.olderThan = val;
            break;
          case '--max-bytes':
            result.maxBytes = parseInt(val, 10);
            if (isNaN(result.maxBytes) || result.maxBytes < 0) {
              const err = new Error(`Invalid --max-bytes: "${val}" must be a non-negative integer`);
              err.exitCode = 2;
              throw err;
            }
            break;
          case '--timeout-sec':
            result.timeoutSec = parseInt(val, 10);
            if (isNaN(result.timeoutSec) || result.timeoutSec < 0) {
              const err = new Error(`Invalid --timeout-sec: "${val}" must be a non-negative integer`);
              err.exitCode = 2;
              throw err;
            }
            break;
          case '--access':
            if (!['read-only', 'workspace', 'full'].includes(val)) {
              const err = new Error(`Invalid --access "${val}": must be "read-only", "workspace", or "full"`);
              err.exitCode = 2;
              throw err;
            }
            result.access = val;
            break;
          case '--reasoning-effort': result.reasoningEffort = val; break;
          case '--variant': result.variant = val; break;
          case '--effort': result.effort = val; break;
          case '--live-smoke-timeout-sec':
            result.liveSmokeTimeoutSec = parseInt(val, 10);
            if (isNaN(result.liveSmokeTimeoutSec) || result.liveSmokeTimeoutSec < 0) {
              const err = new Error(`Invalid --live-smoke-timeout-sec: "${val}" must be a non-negative integer`);
              err.exitCode = 2;
              throw err;
            }
            break;
          case '--range': result.range = val; break;
          case '--path':
            if (!result.paths) result.paths = [];
            result.paths.push(val);
            break;
          case '--intent': result.intent = val; break;
          case '--focus': result.focus = val; break;
          case '--message': result.message = val; break;
          case '--resume':
            result.resume = val;
            break;
          case '--mode':
            if (!['run', 'implement'].includes(val)) {
              const err = new Error(`Invalid --mode "${val}": must be "run" or "implement"`);
              err.exitCode = 2;
              throw err;
            }
            result.mode = val;
            break;
          case '--kind':
            if (!['continue_backend_session', 'fork_from_artifacts', 'retry_attempt'].includes(val)) {
              const err = new Error(`Invalid --kind "${val}": must be "continue_backend_session", "fork_from_artifacts", or "retry_attempt"`);
              err.exitCode = 2;
              throw err;
            }
            result.kind = val;
            break;
        }
        i++;
        continue;
      }

      const err = new Error(`Unknown flag: ${arg}`);
      err.exitCode = 2;
      throw err;
    }

    if (!result.command) {
      if (COMMANDS.has(arg)) {
        result.command = arg;
        i++;
        continue;
      }
    }

    result.positionals.push(arg);
    i++;
  }

  validatePositionals(result);

  return result;
}

function validatePositionals(parsed) {
  const cmd = parsed.command;
  if (!cmd) return;

  const freeText = new Set(['run', 'submit', 'review', 'resume']);
  const singlePos = new Set(['status', 'wait', 'read', 'tail', 'debug', 'diff', 'apply', 'cancel']);
  const zeroPos = new Set(['list', 'cleanup']);

  if (freeText.has(cmd)) return;

  if (zeroPos.has(cmd) && parsed.positionals.length > 0) {
    const err = new Error(`"${cmd}" does not accept positional arguments`);
    err.exitCode = 2;
    throw err;
  }

  if (singlePos.has(cmd) && parsed.positionals.length > 1) {
    const err = new Error(`"${cmd}" accepts at most 1 positional argument (job ID)`);
    err.exitCode = 2;
    throw err;
  }
}

async function resolvePrompt({ promptFile, stdinPipeActive, positionals }) {
  if (promptFile) {
    try {
      return require('fs').readFileSync(promptFile, 'utf8');
    } catch (err) {
      const e = new Error(`Cannot read --prompt-file "${promptFile}": ${err.message}`);
      e.exitCode = 2;
      throw e;
    }
  }

  if (stdinPipeActive) {
    return readStdinBounded();
  }

  if (positionals.length > 0) {
    return positionals.join(' ');
  }

  return '';
}

function readStdinBounded() {
  const deadlineMs = resolveDeadline('STDIN_READ_MS');
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;

    function cleanup() {
      if (settled) return;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
    }

    function finish() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(chunks.join(''));
    }

    const timer = setTimeout(finish, deadlineMs);

    function onData(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    }

    function onEnd() {
      finish();
    }

    function onError(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    if (process.stdin.isPaused()) {
      process.stdin.resume();
    }
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}

// Simple numeric semver-style comparison: returns -1, 0, or 1.
function compareVersions(a, b) {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aVal = aParts[i] || 0;
    const bVal = bParts[i] || 0;
    if (aVal < bVal) return -1;
    if (aVal > bVal) return 1;
  }
  return 0;
}

function isVersionInRange(version, range) {
  if (range.min && compareVersions(version, range.min) < 0) return false;
  if (range.max && compareVersions(version, range.max) >= 0) return false;
  return true;
}

async function tryDisposeAdapter(adapter, attempt) {
  if (!adapter || typeof adapter.Dispose !== 'function') return { disposed: false, reason: 'no_adapter' };
  const ms = resolveDeadline('ADAPTER_DISPOSE_MS');
  try {
    const disposeWork = adapter.Dispose(attempt);
    const completed = await Promise.race([
      (async () => { await disposeWork; return true; })(),
      new Promise(resolve => setTimeout(() => resolve(false), ms)),
    ]);
    return { disposed: true, exceeded: !completed };
  } catch (err) {
    return { disposed: false, reason: err.message || 'dispose_error' };
  }
}

module.exports = { buildEnvelope, parseArgs, resolvePrompt, KNOWN_FLAGS, COMMANDS, compareVersions, isVersionInRange, tryDisposeAdapter, classifyTerminalFailure, maybeAccessHint, NO_RESULT_BYTE_THRESHOLD };
