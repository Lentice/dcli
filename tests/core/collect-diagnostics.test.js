// @suite full
const assert = require('node:assert');

const { CodexAdapter } = require('../../adapters/codex/adapter');
const { ClaudeAdapter } = require('../../adapters/claude/adapter');
const { OpencodeAdapter } = require('../../adapters/opencode/adapter');
const { FakeAdapter } = require('../../adapters/fake/adapter');

async function main() {

// ===========================================================================
// 1. FakeAdapter: exit_code 137 is reported correctly
// ===========================================================================
{
  const adapter = new FakeAdapter({ exitCode: 137 });
  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.exit_code, 137,
    `FakeAdapter must return exit_code 137, got ${diag.exit_code}`);
  console.log('PASS: FakeAdapter reports exit_code 137');
}

// ===========================================================================
// 2. CodexAdapter: exit_code from _resolveExitCode
//    With no process_exited fact, returns null
// ===========================================================================
{
  const adapter = new CodexAdapter();
  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.exit_code, null,
    `Without process_exited fact, exit_code must be null, got ${diag.exit_code}`);
  console.log('PASS: CodexAdapter returns null when no process_exited fact');
}

// ===========================================================================
// 3. CodexAdapter: _resolveExitCode reads the process_exited fact
// ===========================================================================
{
  const adapter = new CodexAdapter();
  adapter._facts = [
    { type: 'started', backend_pid: 1, backend_session_id: null },
    { type: 'process_exited', code: 137 },
  ];
  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.exit_code, 137,
    `exit code 137 from facts must be honoured, got ${diag.exit_code}`);
  console.log('PASS: CodexAdapter honours the process_exited fact');
}

// ===========================================================================
// 4. ClaudeAdapter: null when no process_exited fact
// ===========================================================================
{
  const adapter = new ClaudeAdapter();
  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.exit_code, null,
    `Without process_exited, claude exit_code must be null, got ${diag.exit_code}`);
  console.log('PASS: ClaudeAdapter returns null without process_exited');
}

// ===========================================================================
// 5. ClaudeAdapter honours the process_exited fact
// ===========================================================================
{
  const adapter = new ClaudeAdapter();
  adapter._facts = [
    { type: 'started', backend_pid: 1, backend_session_id: null },
    { type: 'process_exited', code: 130 },
  ];
  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.exit_code, 130,
    `exit code 130 from facts must be honoured, got ${diag.exit_code}`);
  console.log('PASS: ClaudeAdapter honours the process_exited fact');
}

// ===========================================================================
// 6. OpencodeAdapter: null when no turn has run
// ===========================================================================
{
  const adapter = new OpencodeAdapter();
  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.exit_code, null,
    `Without a completed turn, opencode exit_code must be null, got ${diag.exit_code}`);
  console.log('PASS: OpencodeAdapter returns null without a completed turn');
}

// ===========================================================================
// 7. OpencodeAdapter reports the exit code its turn actually emitted
// ===========================================================================
{
  const { FakeTransport } = require('../fixtures/fake-transport');
  const adapter = new OpencodeAdapter({
    transport: new FakeTransport({
      script: {
        '/project/current': { directory: __dirname },
        '/session': { id: 'ses_diag' },
        '/session/ses_diag/prompt_async': { status: 204 },
        '/session/status': { ses_diag: { type: 'idle' } },
        '/session/ses_diag/message': {
          parts: [
            { id: 'p1', messageID: 'msg_1', type: 'text', text: 'done' },
            { id: 'p2', messageID: 'msg_1', type: 'step-finish', reason: 'stop', tokens: { total: 10, input: 5, output: 5 } },
          ],
        },
        '/permission': [],
        '/question': [],
      },
    }),
  });
  adapter.PrepareInvocation({}, { canonicalDir: __dirname, access: 'read-only' });
  await adapter.Start({});
  await adapter.SendPrompt({}, 'run me');
  for await (const fact of adapter.Observe({})) {
    if (fact.type === 'process_exited') break;
  }
  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.exit_code, 0,
    `a completed turn must report its process_exited code, got ${diag.exit_code}`);
  assert.ok(diag.facts_emitted > 0, 'facts_emitted must reflect the turn');
  console.log('PASS: OpencodeAdapter reports the exit code its turn emitted');
}

// ===========================================================================
// 8. CodexAdapter: _resolveExitCode reads from _facts
// ===========================================================================
{
  const adapter = new CodexAdapter();
  adapter._facts = [
    { type: 'started', backend_pid: 1, backend_session_id: null },
    { type: 'process_exited', code: 2 },
  ];
  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.exit_code, 2,
    `Must return exit code 2 from facts, got ${diag.exit_code}`);
  console.log('PASS: CodexAdapter reads exit_code from process_exited fact');
}

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
