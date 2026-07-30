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
// 2. CodexAdapter in test mode: exit_code from _resolveExitCode
//    With _mockExitCode null and no facts, returns null
// ===========================================================================
{
  const adapter = new CodexAdapter({ _testMode: true, _mockVersion: '0.145.0' });
  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.exit_code, null,
    `Without process_exited fact, exit_code must be null, got ${diag.exit_code}`);
  console.log('PASS: CodexAdapter returns null when no process_exited fact');
}

// ===========================================================================
// 3. CodexAdapter in test mode: _mockExitCode overrides facts
// ===========================================================================
{
  const adapter = new CodexAdapter({ _testMode: true, _mockExitCode: 137, _mockVersion: '0.145.0' });
  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.exit_code, 137,
    `_mockExitCode 137 must be honoured, got ${diag.exit_code}`);
  console.log('PASS: CodexAdapter honours _mockExitCode');
}

// ===========================================================================
// 4. ClaudeAdapter: null when no process_exited fact
// ===========================================================================
{
  const adapter = new ClaudeAdapter({ _testMode: true, _mockVersion: '1.0.0' });
  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.exit_code, null,
    `Without process_exited, claude exit_code must be null, got ${diag.exit_code}`);
  console.log('PASS: ClaudeAdapter returns null without process_exited');
}

// ===========================================================================
// 5. ClaudeAdapter honours _mockExitCode
// ===========================================================================
{
  const adapter = new ClaudeAdapter({ _testMode: true, _mockExitCode: 130, _mockVersion: '1.0.0' });
  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.exit_code, 130,
    `_mockExitCode 130 must be honoured, got ${diag.exit_code}`);
  console.log('PASS: ClaudeAdapter honours _mockExitCode');
}

// ===========================================================================
// 6. OpencodeAdapter: null when no process_exited fact
// ===========================================================================
{
  const adapter = new OpencodeAdapter({ _testMode: true, _mockVersion: '1.18.8' });
  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.exit_code, null,
    `Without process_exited, opencode exit_code must be null, got ${diag.exit_code}`);
  console.log('PASS: OpencodeAdapter returns null without process_exited');
}

// ===========================================================================
// 7. OpencodeAdapter honours _mockExitCode
// ===========================================================================
{
  const adapter = new OpencodeAdapter({ _testMode: true, _mockExitCode: 143, _mockVersion: '1.18.8' });
  const diag = adapter.CollectDiagnostics({});
  assert.strictEqual(diag.exit_code, 143,
    `_mockExitCode 143 must be honoured, got ${diag.exit_code}`);
  console.log('PASS: OpencodeAdapter honours _mockExitCode');
}

// ===========================================================================
// 8. CodexAdapter: _resolveExitCode reads from _facts
// ===========================================================================
{
  const adapter = new CodexAdapter({ _testMode: true, _mockVersion: '0.145.0' });
  adapter.CollectResult = function () { return { text: '' }; };
  adapter._facts = [
    { type: 'started', backend_pid: 1, backend_session_id: 's' },
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
