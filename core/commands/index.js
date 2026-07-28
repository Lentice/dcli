const { generateJobId } = require('../job-id');

const KNOWN_FLAGS = new Set([
  '--backend', '--repo', '--prompt-file', '--hard-timeout-sec', '--group', '--label',
  '--model', '--json', '--timeout-sec', '--all', '--help',
]);

const COMMANDS = new Set(['run', 'submit', 'status', 'wait', 'read', 'list', 'cancel', 'review']);

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

      const valueFlag = new Set(['--backend', '--repo', '--prompt-file', '--hard-timeout-sec',
        '--group', '--label', '--model', '--timeout-sec']);

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
          case '--timeout-sec':
            result.timeoutSec = parseInt(val, 10);
            if (isNaN(result.timeoutSec) || result.timeoutSec < 0) {
              const err = new Error(`Invalid --timeout-sec: "${val}" must be a non-negative integer`);
              err.exitCode = 2;
              throw err;
            }
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

  const freeText = new Set(['run', 'submit']);
  const singlePos = new Set(['status', 'wait', 'read']);
  const zeroPos = new Set(['list']);

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

function resolvePrompt({ promptFile, stdinPipeActive, positionals }) {
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
    return null;
  }

  if (positionals.length > 0) {
    return positionals.join(' ');
  }

  return '';
}

module.exports = { buildEnvelope, parseArgs, resolvePrompt, KNOWN_FLAGS, COMMANDS };
