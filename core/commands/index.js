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
]);

const COMMANDS = new Set(['run', 'submit', 'status', 'wait', 'read', 'list', 'cancel', 'review', 'tail', 'debug', 'cleanup', 'capabilities', 'doctor', 'diff', 'apply']);

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
      if (arg === '--json') {
        result.json = true;
        i++;
        continue;
      }
      if (arg === '--all') {
        result.waitAll = true;
        i++;
        continue;
      }
      if (arg === '--dry-run') {
        result.dryRun = true;
        i++;
        continue;
      }
      if (arg === '--scrub-session-ids') {
        result.scrubSessionIds = true;
        i++;
        continue;
      }
      if (arg === '--staged') {
        result.staged = true;
        i++;
        continue;
      }
      if (arg === '--working') {
        result.working = true;
        i++;
        continue;
      }
      if (arg === '--include-untracked') {
        result.includeUntracked = true;
        i++;
        continue;
      }
      if (arg === '--embed-diff') {
        result.embedDiff = true;
        i++;
        continue;
      }
      if (arg === '--stat') {
        result.stat = true;
        i++;
        continue;
      }
      if (arg === '--name-only') {
        result.nameOnly = true;
        i++;
        continue;
      }
      if (arg === '--reset-author') {
        result.resetAuthor = true;
        i++;
        continue;
      }
      if (arg === '--allow-untracked') {
        result.allowUntracked = true;
        i++;
        continue;
      }

      const valueFlag = new Set(['--backend', '--repo', '--prompt-file', '--hard-timeout-sec',
        '--group', '--label', '--model', '--timeout-sec', '--older-than', '--max-bytes',
        '--reasoning-effort', '--variant', '--effort', '--live-smoke-timeout-sec',
        '--access', '--range', '--path', '--intent', '--focus',
        '--message', '--mode']);

      if (valueFlag.has(arg)) {
        i++;
        if (i >= args.length || args[i].startsWith('--')) {
          const err = new Error(`Flag ${arg} requires a value`);
          err.exitCode = 2;
          throw err;
        }
        const val = args[i];
        switch (arg) {
          case '--backend': result.backend = val; break;
          case '--repo': result.repo = val; break;
          case '--prompt-file': result.promptFile = val; break;
          case '--hard-timeout-sec':
            result.hardTimeoutSec = parseInt(val, 10);
            if (isNaN(result.hardTimeoutSec) || result.hardTimeoutSec < 0) {
              const err = new Error(`Invalid --hard-timeout-sec: "${val}" must be a non-negative integer`);
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
          case '--mode':
            if (!['run', 'implement'].includes(val)) {
              const err = new Error(`Invalid --mode "${val}": must be "run" or "implement"`);
              err.exitCode = 2;
              throw err;
            }
            result.mode = val;
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

  const freeText = new Set(['run', 'submit', 'review']);
  const singlePos = new Set(['status', 'wait', 'read', 'tail', 'debug', 'diff', 'apply']);
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

module.exports = { buildEnvelope, parseArgs, resolvePrompt, KNOWN_FLAGS, COMMANDS, compareVersions, isVersionInRange };
