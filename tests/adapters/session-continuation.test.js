// @suite quick
// `resume --kind continue_backend_session` reported success while continuing
// nothing: the follow-up ran in a brand new conversation with none of the
// parent's context. Three independent causes, one per layer:
//
//   * the engine handed the parent's session id to adapter.Resume(), which runs
//     in onStarted — after Start(). A backend that fixes its session at process
//     launch has already launched by then. The session to continue now travels
//     on the request, so PrepareInvocation sees it.
//   * the claude adapter passed the id as --session-id, which NAMES a new
//     session rather than resuming one, and additionally passed
//     --no-session-persistence, so the parent transcript was never written.
//   * the opencode adapter's Resume() was an empty method and SendPrompt
//     unconditionally POSTed a new /session.
//
// These assert the observable argv and the HTTP calls actually made.
const assert = require('node:assert');

async function main() {

// ===========================================================================
// 1. claude argv: --resume continues, --session-id names a new session, and
//    the transcript must be persisted or there is nothing to resume
// ===========================================================================
{
  const { buildArgv } = require('../../adapters/claude/adapter');

  const fresh = buildArgv({ sessionId: 'new-uuid', permissionMode: 'auto' });
  assert.ok(fresh.includes('--session-id'), 'a fresh job names its own session');
  assert.strictEqual(fresh[fresh.indexOf('--session-id') + 1], 'new-uuid');
  assert.ok(!fresh.includes('--resume'), 'a fresh job resumes nothing');

  const cont = buildArgv({ sessionId: 'parent-uuid', resumeSessionId: 'parent-uuid', permissionMode: 'auto' });
  assert.ok(cont.includes('--resume'), 'a continuation must use --resume');
  assert.strictEqual(cont[cont.indexOf('--resume') + 1], 'parent-uuid');
  assert.ok(!cont.includes('--session-id'),
    '--session-id would start a new conversation that merely reuses the id');

  for (const argv of [fresh, cont]) {
    assert.ok(!argv.includes('--no-session-persistence'),
      'an unpersisted session cannot be resumed, and this backend declares resume');
  }

  console.log('PASS: claude continuation argv');
}

// ===========================================================================
// 2. claude Start() carries the request's resume session into argv
// ===========================================================================
{
  const { ClaudeAdapter } = require('../../adapters/claude/adapter');
  const adapter = new ClaudeAdapter({});
  const savedPath = process.env.CLAUDE_PATH;
  process.env.CLAUDE_PATH = process.env.ComSpec || 'cmd.exe';

  try {
    adapter.PrepareInvocation({}, {
      canonicalDir: process.platform === 'win32' ? 'C:\\Windows' : '/tmp',
      access: 'read-only',
      resumeSessionId: 'parent-session-42',
    });
    await adapter.Start({});
    const argv = (adapter._childProcess.spawnargs || []).join(' ');
    assert.ok(argv.includes('--resume'), `child argv must carry --resume; got ${argv.slice(0, 300)}`);
    assert.ok(argv.includes('parent-session-42'), 'child argv must carry the parent session id');
    assert.strictEqual(adapter._sessionId, 'parent-session-42',
      'a continued job keeps the parent session id, it does not mint a new one');
  } finally {
    if (adapter._childProcess) { try { adapter._childProcess.kill(); } catch {} }
    try { adapter.Dispose({}); } catch {}
    if (savedPath === undefined) delete process.env.CLAUDE_PATH;
    else process.env.CLAUDE_PATH = savedPath;
  }

  console.log('PASS: claude Start carries resumeSessionId');
}

// ===========================================================================
// 3. opencode posts into the parent session instead of creating a new one
// ===========================================================================
{
  const { OpencodeAdapter } = require('../../adapters/opencode/adapter');
  const { FakeTransport } = require('../fixtures/fake-transport');

  async function sendWith(request) {
    const transport = new FakeTransport({
      script: {
        '/project/current': { directory: request.canonicalDir },
        '/session': { id: 'ses_new' },
        '/session/ses_new/prompt_async': { status: 204 },
        '/session/ses_parent/prompt_async': { status: 204 },
      },
    });
    const adapter = new OpencodeAdapter({ transport });
    adapter.PrepareInvocation({}, request);
    await adapter.SendPrompt({}, 'hi');
    return { calls: transport.calls.map(c => `${c.method} ${c.path.split('?')[0]}`), sessionId: adapter._sessionId };
  }

  const canonicalDir = __dirname;

  const fresh = await sendWith({ canonicalDir, access: 'read-only' });
  assert.ok(fresh.calls.includes('POST /session'), 'a fresh job creates a session');
  assert.strictEqual(fresh.sessionId, 'ses_new');

  const cont = await sendWith({ canonicalDir, access: 'read-only', resumeSessionId: 'ses_parent' });
  assert.ok(!cont.calls.includes('POST /session'),
    'a continuation must not create a new session — that is how the context was lost');
  assert.strictEqual(cont.sessionId, 'ses_parent');
  assert.ok(cont.calls.some(c => c === 'POST /session/ses_parent/prompt_async'),
    `the prompt must be posted into the parent session; calls were ${JSON.stringify(cont.calls)}`);

  console.log('PASS: opencode continuation reuses the parent session');
}

}

main().then(() => console.log('\nAll session-continuation tests passed')).catch((err) => {
  console.error('FAIL:', err && err.stack || err);
  process.exit(1);
});
