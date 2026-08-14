// @suite quick
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseArgs, resolvePrompt, maybeAccessHint } = require('../../core/cli-args');

async function main() {

// ===========================================================================
// 1. Positional prompt works (lowest precedence)
// ===========================================================================
{
  // Simulate: no --prompt-file, stdin not piped (isTTY), positional = "hello"
  const prompt = await resolvePrompt({ promptFile: null, stdinPipeActive: false, positionals: ['hello'] });
  assert.strictEqual(prompt, 'hello', 'positional text must be used when no other source');
}
console.log('PASS: run test 3 — positional prompt');

// ===========================================================================
// 2. --prompt-file has highest precedence
// ===========================================================================
{
  const pFile = path.join(os.tmpdir(), 'dcli-test-prompt-' + Date.now());
  fs.writeFileSync(pFile, 'file-content', 'utf8');
  try {
    const prompt = await resolvePrompt({ promptFile: pFile, stdinPipeActive: false, positionals: ['pos'] });
    assert.strictEqual(prompt, 'file-content', '--prompt-file must have highest precedence');
  } finally {
    try { fs.unlinkSync(pFile); } catch {}
  }
}
console.log('PASS: run test 4 — --prompt-file precedence');

// ===========================================================================
// 3. Present-but-unusable --prompt-file is an error
// ===========================================================================
{
  await assert.rejects(
    resolvePrompt({ promptFile: '/nonexistent/file.md', stdinPipeActive: false, positionals: [] }),
    /prompt-file/i,
    'unreadable --prompt-file must throw'
  );
}
console.log('PASS: run test 5 — unusable --prompt-file is error');

// ===========================================================================
// 4. Valueless flags rejected with exit 2
// ===========================================================================
{
  // --group without value
  try {
    parseArgs(['--backend', 'fake', 'run', '--group']);
    assert.fail('Should have thrown for valueless --group');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2, 'valueless flag must throw exit 2');
    assert.ok(err.message.toLowerCase().includes('group') ||
              err.message.toLowerCase().includes('value'),
      `Error must mention the flag: ${err.message}`);
  }

  // --hard-timeout-sec without value
  try {
    parseArgs(['--backend', 'fake', 'run', '--hard-timeout-sec']);
    assert.fail('Should have thrown for valueless --hard-timeout-sec');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2);
  }
}
console.log('PASS: valueless flags rejected');

// ===========================================================================
// 5. Unknown flags rejected with exit 2
// ===========================================================================
{
  try {
    parseArgs(['--backend', 'fake', 'run', '--bogus-flag']);
    assert.fail('Should have thrown for unknown flag');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2);
    assert.ok(err.message.includes('bogus') || err.message.includes('unknown'),
      `Error must mention unknown flag: ${err.message}`);
  }
}
console.log('PASS: unknown flags rejected');

// ===========================================================================
// 6. Ticket 131 deliberately removed --reasoning-effort; keep the old flag
//    rejected so it cannot be reintroduced as an alias
// ===========================================================================
{
  try {
    parseArgs(['--backend', 'fake', 'run', '--reasoning-effort', 'high']);
    assert.fail('Should have thrown for removed --reasoning-effort flag');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2, 'removed --reasoning-effort must exit 2');
    assert.strictEqual(err.message, 'Unknown flag: --reasoning-effort',
      `Error must name the removed flag: ${err.message}`);
  }
}
console.log('PASS: ticket 131 removed --reasoning-effort flag stays rejected');

// ===========================================================================
// 7. Stray positionals rejected
// ===========================================================================
{
  // For status/wait/read which take exactly one positional (job ID),
  // extra positionals should be rejected
  try {
    parseArgs(['--backend', 'fake', 'status', '20260804T123456Z-a1b2c3d4', 'extra-arg']);
    assert.fail('Should have thrown for stray positionals');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2, 'stray positionals must throw exit 2');
  }
}
console.log('PASS: stray positionals rejected');

// ===========================================================================
// 8. Range validation precedes conversion
// ===========================================================================
{
  // Negative timeout must be rejected BEFORE any side effect
  // (the store or adapter should not be touched)
  try {
    parseArgs(['--backend', 'fake', 'run', '--hard-timeout-sec', '-5']);
    assert.fail('Should have thrown for negative timeout');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2, 'negative timeout must exit 2');
  }
}
console.log('PASS: range validation precedes conversion');

// ===========================================================================
// 9. --hard-timeout-sec 0 is rejected with exit 2
// ===========================================================================
{
  try {
    parseArgs(['--backend', 'fake', 'run', '--hard-timeout-sec', '0']);
    assert.fail('Should have thrown for --hard-timeout-sec 0');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2, '--hard-timeout-sec 0 must exit 2');
    assert.ok(err.message.includes('positive integer'),
      `Error must mention "positive integer": ${err.message}`);
  }

  try {
    parseArgs(['--backend', 'fake', 'resume', '--hard-timeout-sec', '0',
      '--kind', 'continue_backend_session', 'parent-job-id']);
    assert.fail('Should have thrown for --hard-timeout-sec 0 on resume');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2, 'resume with --hard-timeout-sec 0 must exit 2');
  }

  try {
    parseArgs(['--backend', 'fake', 'submit', '--hard-timeout-sec', '0', 'background job']);
    assert.fail('Should have thrown for --hard-timeout-sec 0 on submit');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2, 'submit with --hard-timeout-sec 0 must exit 2');
  }
}
console.log('PASS: --hard-timeout-sec 0 rejected');

// ===========================================================================
// 10. --backend enum validation (unknown backend rejected)
// ===========================================================================
{
  try {
    parseArgs(['node', 'dcli', '--backend', 'nonesuch', 'run', '--hard-timeout-sec', '60', 'prompt']);
    assert.fail('Should have thrown for unknown backend');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2, 'unknown backend must exit 2');
    assert.ok(err.message.includes('nonesuch'), `Error must name the backend: ${err.message}`);
    assert.ok(err.message.includes('opencode'), `Error must list valid backends: ${err.message}`);
  }
}
console.log('PASS: unknown backend rejected');

// ===========================================================================
// 11. --backend with path traversal rejected
// ===========================================================================
{
  try {
    parseArgs(['node', 'dcli', '--backend', '..\\..\\foo', 'run', '--hard-timeout-sec', '60', 'prompt']);
    assert.fail('Should have thrown for path-traversal backend');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2, 'path-traversal backend must exit 2');
  }
}
console.log('PASS: path-traversal backend rejected');

// ===========================================================================
// 12. --backend set twice is rejected
// ===========================================================================
{
  try {
    parseArgs(['node', 'dcli', '--backend', 'codex', '--backend', 'claude', 'run', '--hard-timeout-sec', '60', 'prompt']);
    assert.fail('Should have thrown for double --backend');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2, 'double --backend must exit 2');
    assert.ok(err.message.includes('twice'), `Error must mention duplicate: ${err.message}`);
  }
}
console.log('PASS: double --backend rejected');

// ===========================================================================
// 13. --access enum: only the contract values are accepted (ticket 108);
//     'full' is rejected at the argument boundary with a message naming the
//     two valid values
// ===========================================================================
{
  try {
    parseArgs(['--backend', 'fake', 'run', '--access', 'full', 'prompt']);
    assert.fail('Should have thrown for --access full');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2, '--access full must exit 2');
    assert.ok(err.message.includes('read-only'), `Error must name "read-only": ${err.message}`);
    assert.ok(err.message.includes('workspace'), `Error must name "workspace": ${err.message}`);
    assert.ok(!err.message.includes('or "full"'), `Error must not offer "full": ${err.message}`);
  }

  const ro = parseArgs(['--backend', 'fake', 'run', '--access', 'read-only', 'prompt']);
  assert.strictEqual(ro.access, 'read-only', '--access read-only must be accepted');

  const ws = parseArgs(['--backend', 'fake', 'submit', '--access', 'workspace', 'prompt']);
  assert.strictEqual(ws.access, 'workspace', '--access workspace must be accepted on submit');
}
console.log('PASS: --access enum boundary');

// ===========================================================================
// 14. --embed-diff defaults true and --no-embed-diff is an explicit opt-out
// ===========================================================================
{
  const review = (...flags) => parseArgs(['node', 'dcli', '--backend', 'fake', 'review', ...flags]);
  assert.notStrictEqual(review().embedDiff, false, 'review defaults to embedding the diff');
  assert.strictEqual(review('--embed-diff').embedDiff, true, '--embed-diff must enable embedding');
  assert.strictEqual(review('--no-embed-diff').embedDiff, false, '--no-embed-diff must disable embedding');
  assert.strictEqual(review('--embed-diff', '--no-embed-diff').embedDiff, false, 'last flag must win');
  assert.strictEqual(review('--no-embed-diff', '--embed-diff').embedDiff, true, 'last flag must win');
}
console.log('PASS: review diff embedding flags');

// ===========================================================================
// 15. maybeAccessHint unit: hint fires on tool-dispatch prompts with read-only
//     access, does NOT fire on plain questions or non-read-only access, and
//     the JSON envelope path is unaffected (hint is a separate emit).
// ===========================================================================
{
  const dispatchHint = maybeAccessHint({
    access: null,  // null means default (read-only)
    prompt: 'Please dispatch a subagent to verify the tickets.',
  });
  assert.ok(dispatchHint, 'hint must fire for "dispatch a subagent" with default access');
  assert.ok(/--access workspace/.test(dispatchHint), 'hint must point at --access workspace');

  const taskHint = maybeAccessHint({
    access: 'read-only',
    prompt: 'Use the Task tool to spawn two agents.',
  });
  assert.ok(taskHint, 'hint must fire for "Task tool" + read-only');

  const writeHint = maybeAccessHint({
    access: 'read-only',
    prompt: 'write a file containing the result.',
  });
  assert.ok(writeHint, 'hint must fire for "write file" + read-only');

  const noFireWorkspace = maybeAccessHint({
    access: 'workspace',
    prompt: 'Please dispatch a subagent.',
  });
  assert.strictEqual(noFireWorkspace, null, 'must not hint when access is already elevated');

  const noFirePlain = maybeAccessHint({
    access: 'read-only',
    prompt: 'What is 2+2?',
  });
  assert.strictEqual(noFirePlain, null, 'must not hint on plain questions');

  const noFireNullPrompt = maybeAccessHint({
    access: 'read-only', prompt: null,
  });
  assert.strictEqual(noFireNullPrompt, null, 'must not hint when prompt is null');

  console.log('PASS: maybeAccessHint unit cases');
}

}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
