// @suite quick
const assert = require('node:assert');
const childProcess = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('SKIP: Windows server tree cleanup test skipped on non-Windows');
} else {
  const originalSpawnSync = childProcess.spawnSync;
  const calls = [];

  childProcess.spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  };

  try {
    delete require.cache[require.resolve('../../../adapters/opencode/adapter')];
    const { OpencodeAdapter } = require('../../../adapters/opencode/adapter');
    const adapter = new OpencodeAdapter();
    let fallbackKillCalled = false;
    adapter._serverProcess = {
      pid: 12345,
      killed: false,
      exitCode: null,
      kill: () => { fallbackKillCalled = true; },
    };

    adapter._killServer();

    assert.deepStrictEqual(calls, [{
      command: 'taskkill',
      args: ['/PID', '12345', '/T', '/F'],
      options: { windowsHide: true, stdio: 'ignore', timeout: 5000 },
    }], 'Windows cleanup must kill the complete process tree');
    assert.strictEqual(fallbackKillCalled, true, 'root kill remains the fallback after taskkill');
    console.log('PASS: Windows server cleanup kills the complete process tree');
  } finally {
    childProcess.spawnSync = originalSpawnSync;
  }
}
