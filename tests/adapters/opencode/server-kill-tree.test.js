// @suite quick
// Windows server tree cleanup, now against the per-job server module
// (ticket 100): kill() must terminate the whole tree via taskkill, with the
// root kill as fallback.
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
    delete require.cache[require.resolve('../../../adapters/opencode/server')];
    const { OpencodeServer } = require('../../../adapters/opencode/server');
    const server = new OpencodeServer({});
    let fallbackKillCalled = false;
    server._process = {
      pid: 12345,
      killed: false,
      exitCode: null,
      kill: () => { fallbackKillCalled = true; },
    };

    server.kill();

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
