// Two ways a caller gets lost at the CLI boundary, both observed in the field:
//
//  1. A job ID minted by another runtime (`b310zq0rm` — a codex-companion id)
//     was reported as `Job not found: 7bf8a8f96d57/b310zq0rm`. The repo_key
//     prefix means nothing to the caller, and "not found" says the job existed
//     and vanished. It never could have been a dcli job.
//  2. `dcli jobs` printed one line of usage. The skill's slash command is
//     `dcli-codex:jobs`, so reaching for `jobs` as a subcommand is the expected
//     mistake, and usage does not correct it.
//
// Asserts exit code and stderr at the CLI boundary — not that parseArgs threw.

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', '..', 'cli', 'dcli.js');

function run(args, stateRoot) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, DCLI_STATE_ROOT: stateRoot },
  });
}

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-arg-diag-'));

try {
  // 1. Foreign id shape, on every read-side command.
  for (const command of ['status', 'read', 'tail', 'debug', 'wait', 'cancel', 'diff', 'apply']) {
    const r = run(['--backend', 'fake', command, 'b310zq0rm'], stateRoot);
    const out = (r.stdout || '') + (r.stderr || '');

    assert.strictEqual(r.status, 2,
      `${command}: a foreign job id is a usage error (exit 2), got ${r.status}: ${out}`);
    assert.ok(/Not a dcli job ID/.test(out), `${command}: must name the real problem, got: ${out}`);
    assert.ok(!/Job not found/.test(out), `${command}: must not claim the job is missing, got: ${out}`);
    assert.ok(!/ReferenceError|TypeError/.test(out), `${command}: must not crash, got: ${out}`);
    console.log(`PASS: ${command} rejects a foreign job id by shape`);
  }

  // A well-formed but absent id still reports not-found (exit 3), unchanged.
  const absent = run(['--backend', 'fake', 'status', '20990101T000000Z-abcdefgh'], stateRoot);
  assert.strictEqual(absent.status, 3,
    `a well-formed absent id must stay exit 3, got ${absent.status}`);
  assert.ok(/Job not found/.test(absent.stderr), `expected not-found, got: ${absent.stderr}`);
  console.log('PASS: a well-formed absent job id still reports not found');

  // 2. Mistyped subcommand gets a suggestion, not usage.
  for (const [typed, suggested] of [['jobs', 'list'], ['ask', 'run'], ['kill', 'cancel']]) {
    const r = run([typed], stateRoot);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.strictEqual(r.status, 2, `${typed}: must exit 2, got ${r.status}: ${out}`);
    assert.ok(new RegExp(`Unknown command: ${typed}`).test(out), `${typed}: got: ${out}`);
    assert.ok(new RegExp(`did you mean '${suggested}'`).test(out),
      `${typed}: must suggest '${suggested}', got: ${out}`);
    console.log(`PASS: '${typed}' suggests '${suggested}'`);
  }

  // An unrecognized command with no near match lists the real commands.
  const wat = run(['flurb'], stateRoot);
  assert.strictEqual(wat.status, 2, `unknown command must exit 2, got ${wat.status}`);
  assert.ok(/Unknown command: flurb/.test(wat.stderr) && /Commands: .*\blist\b/.test(wat.stderr),
    `must list available commands, got: ${wat.stderr}`);
  console.log('PASS: an unrecognized command lists the available commands');

  // A prompt positional after a real command is still a prompt, not a command.
  const submitted = run(['--backend', 'fake', 'submit', 'jobs', '--json'], stateRoot);
  assert.strictEqual(submitted.status, 0,
    `a positional that looks like a command must still be a prompt: ${submitted.stderr}`);
  console.log('PASS: command-like positionals after a command are still positionals');

  console.log('\nAll CLI argument diagnostic tests passed.');
} finally {
  try { fs.rmSync(stateRoot, { recursive: true, force: true }); } catch {}
}
