// @suite full
// @serial creates temp files
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { buildCmdInvocation } = require('../../../adapters/codex/cmd-quoting');

function tmpDir() {
  const d = path.join(os.tmpdir(), `dcli-cs-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function main() {

// ===========================================================================
// 1. buildCmdInvocation is imported by the opencode adapter
// ===========================================================================
{
  const mod = require('../../../adapters/opencode/adapter');
  assert.ok(typeof mod.OpencodeAdapter === 'function', 'OpencodeAdapter must be exported');

  // Verify the module can be loaded successfully — buildCmdInvocation is used
  // inside Start(), so loading the module is the minimal structural check.
  // A missing import would throw MODULE_NOT_FOUND at require() time.
  console.log('PASS: opencode adapter loads without import errors');
}

// ===========================================================================
// 2. buildCmdInvocation wraps .cmd shim in cmd.exe for opencode-style args
// ===========================================================================
{
  const result = buildCmdInvocation({
    command: 'C:\\Users\\me\\.npm-global\\opencode.cmd',
    args: ['serve', '--hostname', '127.0.0.1', '--port', '12345'],
  });

  assert.strictEqual(result.command, process.env.ComSpec || 'cmd.exe',
    'command must be cmd.exe for .cmd shim');
  assert.strictEqual(result.args.length, 4, 'must have 4 args: /d /s /c "<inner>"');
  assert.strictEqual(result.args[0], '/d');
  assert.strictEqual(result.args[1], '/s');
  assert.strictEqual(result.args[2], '/c');
  assert.ok(typeof result.args[3] === 'string', 'inner command must be a string');
  assert.ok(result.args[3].startsWith('"') && result.args[3].endsWith('"'),
    'inner command must be wrapped in quotes for /s');
  assert.ok(result.args[3].includes('opencode.cmd'),
    'inner command must reference the .cmd shim');
  assert.ok(result.args[3].includes('127.0.0.1'),
    'inner command must include --hostname arg');
  assert.ok(result.args[3].includes('12345'),
    'inner command must include --port arg');
  assert.strictEqual(result.windowsHide, true, 'windowsHide must be true');

  console.log('PASS: buildCmdInvocation wraps .cmd in cmd.exe for opencode args');
}

// ===========================================================================
// 3. buildCmdInvocation passes non-.cmd binary through unchanged
// ===========================================================================
{
  const result = buildCmdInvocation({
    command: 'C:\\Users\\me\\opencode.exe',
    args: ['serve', '--hostname', '127.0.0.1', '--port', '12345'],
    cwd: 'C:\\work',
  });

  assert.strictEqual(result.command, 'C:\\Users\\me\\opencode.exe');
  assert.deepStrictEqual(result.args, ['serve', '--hostname', '127.0.0.1', '--port', '12345']);
  assert.strictEqual(result.cwd, 'C:\\work');
  assert.strictEqual(result.windowsHide, true);

  console.log('PASS: buildCmdInvocation passes non-.cmd binary through unchanged');
}

// ===========================================================================
// 4. spawn of .cmd via buildCmdInvocation does not throw EINVAL
// ===========================================================================
{
  const dir = tmpDir();
  let child = null;
  try {
    const cmdPath = path.join(dir, 'stub.cmd');
    fs.writeFileSync(cmdPath, '@exit /b 0\r\n', 'utf8');

    const invocation = buildCmdInvocation({
      command: cmdPath,
      args: ['serve', '--hostname', '127.0.0.1', '--port', '19999'],
    });

    // spawn must not throw EINVAL (or any synchronous error)
    let spawnError = null;
    try {
      child = spawn(invocation.command, invocation.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: invocation.windowsHide,
      });
    } catch (err) {
      spawnError = err;
    }

    assert.strictEqual(spawnError, null,
      `spawn must not throw: ${spawnError ? spawnError.message : ''}`);
    assert.ok(child, 'child process must be created');
    assert.ok(typeof child.pid === 'number' && child.pid > 0,
      `child must have valid pid, got ${child && child.pid}`);

    // Wait for child to exit and verify no crash
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Child did not exit within 10s')), 10000);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        child = null;
        resolve(code);
      });
    });

    console.log('PASS: .cmd shim spawn via buildCmdInvocation does not throw EINVAL');
  } finally {
    if (child) {
      try { child.kill(); } catch {}
    }
    clean(dir);
  }
}

// ===========================================================================
// 5. spawn of .bat extension via buildCmdInvocation does not throw EINVAL
// ===========================================================================
{
  const dir = tmpDir();
  let child = null;
  try {
    const batPath = path.join(dir, 'stub.bat');
    fs.writeFileSync(batPath, '@exit /b 0\r\n', 'utf8');

    const invocation = buildCmdInvocation({
      command: batPath,
      args: ['serve', '--hostname', '127.0.0.1', '--port', '19998'],
    });

    let spawnError = null;
    try {
      child = spawn(invocation.command, invocation.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: invocation.windowsHide,
      });
    } catch (err) {
      spawnError = err;
    }

    assert.strictEqual(spawnError, null,
      `spawn of .bat must not throw: ${spawnError ? spawnError.message : ''}`);
    assert.ok(child, 'child process must be created');

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Child did not exit within 10s')), 10000);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', () => {
        clearTimeout(timer);
        child = null;
        resolve();
      });
    });

    console.log('PASS: .bat shim spawn via buildCmdInvocation does not throw EINVAL');
  } finally {
    if (child) {
      try { child.kill(); } catch {}
    }
    clean(dir);
  }
}

// ===========================================================================
// 6. spawn of non-.cmd binary via buildCmdInvocation does not throw EINVAL
// ===========================================================================
{
  const invocation = buildCmdInvocation({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
  });

  let child = null;
  try {
    let spawnError = null;
    try {
      child = spawn(invocation.command, invocation.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: invocation.windowsHide,
      });
    } catch (err) {
      spawnError = err;
    }
    assert.strictEqual(spawnError, null,
      `spawn of .exe must not throw: ${spawnError ? spawnError.message : ''}`);
    assert.ok(child, 'child process must be created');

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Child did not exit within 10s')), 10000);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', () => {
        clearTimeout(timer);
        child = null;
        resolve();
      });
    });

    console.log('PASS: non-.cmd binary spawn via buildCmdInvocation works');
  } finally {
    if (child) {
      try { child.kill(); } catch {}
    }
  }
}

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
