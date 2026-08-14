const { isJobId } = require('./job-id');
const { resolveDeadline } = require('./deadlines');
const { parseDuration } = require('./commands/cleanup');
const { KNOWN_BACKENDS } = require('../adapters/registry');

// The only access modes the contract knows (design-spec §16). Exported so the
// adapter parity gate can derive the parser's accepted set from here instead
// of hard-coding a second copy that can drift.
const ACCESS_VALUES = Object.freeze(['read-only', 'workspace']);

// The skill slash commands (`:jobs`, `:ask`, `:implement`, ...) do not
// map 1:1 onto CLI subcommands, and an agent reading the skill reaches for the
// slash-command name. Point at the real subcommand instead of printing usage.
const COMMAND_SUGGESTIONS = Object.freeze({
  jobs: 'list',
  ls: 'list',
  ask: 'run',
  implement: 'run --mode implement',
  result: 'read',
  results: 'read',
  show: 'status',
  state: 'status',
  logs: 'tail',
  kill: 'cancel',
  stop: 'cancel',
  health: 'doctor',
  check: 'doctor',
});

const COMMANDS = new Set(['run', 'submit', 'status', 'wait', 'read', 'list', 'cancel', 'review', 'resume', 'tail', 'debug', 'cleanup', 'capabilities', 'doctor', 'diff', 'apply']);

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
      if (arg === '--no-embed-diff') {
        result.embedDiff = false;
        i++;
        continue;
      }

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
            parseDuration(val);
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
            if (!ACCESS_VALUES.includes(val)) {
              const err = new Error(`Invalid --access "${val}": must be ${ACCESS_VALUES.map(v => `"${v}"`).join(' or ')}`);
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
      // The first non-flag token is the subcommand slot. Anything else there is
      // a mistyped command, not a positional — printing usage made
      // `dcli jobs` look like a missing-argument problem.
      const suggestion = COMMAND_SUGGESTIONS[arg.toLowerCase()];
      const err = new Error(`Unknown command: ${arg}`
        + (suggestion ? ` — did you mean '${suggestion}'?` : `\nCommands: ${[...COMMANDS].join(', ')}`));
      err.exitCode = 2;
      throw err;
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

  // A job id in the wrong shape cannot name a dcli job at all. Reported as
  // "Job not found: <repo_key>/<id>" it read as a dcli job that vanished, and
  // the repo_key prefix means nothing to the caller — so an id minted by
  // another runtime (an observed case: a short opaque id from a plugin runtime)
  // sent the caller searching a job store that could never hold it.
  // Checked here, at the argument boundary, because that is the only place a
  // foreign id can enter; core lookups take ids the engine itself minted.
  const jobIdPositional = (singlePos.has(cmd) || cmd === 'resume') ? parsed.positionals[0] : null;
  for (const id of [jobIdPositional, parsed.resume]) {
    if (id !== null && id !== undefined && !isJobId(id)) throw notAJobIdError(id);
  }

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

function notAJobIdError(id) {
  const err = new Error(
    `Not a dcli job ID: "${id}". dcli job IDs look like 20260804T123456Z-a1b2c3d4. ` +
    'This id may belong to another runtime; run `list` to see this repository\'s dcli jobs.');
  err.exitCode = 2;
  return err;
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

module.exports = { parseArgs, resolvePrompt, maybeAccessHint, ACCESS_VALUES };
