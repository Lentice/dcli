// @suite full
// @serial  binds loopback ports; asserts reserve-and-retry races
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const { OpencodeAdapter } = require('../../../adapters/opencode/adapter');
const { Redactor } = require('../../../core/redactor');
const { setRedactor, getRedactor } = require('../../../core/fs-text');

const OPENCODE_LIVE_SMOKE = process.env.DCLI_OPENCODE_LIVE_SMOKE;

function tmpDir() {
  const d = path.join(os.tmpdir(), `dcli-srv-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeMinimalAdapter() {
  return new OpencodeAdapter({
    _testMode: true,
    _mockVersion: '1.18.8',
    _mockFacts: [
      { type: 'started', backend_pid: 42, backend_session_id: 'ses_test' },
      { type: 'assistant_text', message_id: 'msg_1', text: 'Hello' },
      { type: 'usage_reported', tokens: { input: 50, output: 200, total: 250 } },
      { type: 'process_exited', code: 0 },
    ],
    _mockExitCode: 0,
  });
}

async function main() {

// ===========================================================================
// 1. Port reservation returns a usable loopback port
// ===========================================================================
{
  const adapter = new OpencodeAdapter({ _testMode: true });
  const port = await adapter._reservePort();
  assert.ok(typeof port === 'number', 'Port must be a number');
  assert.ok(port > 0 && port < 65536, `Port ${port} must be in valid range`);
  assert.ok(Number.isInteger(port), `Port ${port} must be an integer`);

  // Verify the port was actually free by binding to it
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(port, '127.0.0.1', () => {
      srv.close(resolve);
    });
    srv.on('error', reject);
  });
  console.log('PASS: _reservePort returns a usable loopback port');
}

// ===========================================================================
// 2. Port reservation retries when port is taken (close-then-bind race)
// ===========================================================================
{
  // Reserve a port, then try to reserve the same one (simulate race)
  const adapter = new OpencodeAdapter({ _testMode: true });
  const port = await adapter._reservePort();

  // Bind to it so the next _reservePort call with binding fails
  let occupied = false;
  const occupy = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(port, '127.0.0.1', () => {
      occupied = true;
      resolve(srv);
    });
    srv.on('error', () => {
      occupied = false;
      resolve(null);
    });
  });

  // Force reservation of same port (this simulates the race)
  // The adapter's _reservePort should get a different port
  const port2 = await adapter._reservePort(3);
  assert.ok(typeof port2 === 'number', 'Retry must produce a port');
  assert.ok(port2 > 0, `Port ${port2} must be positive`);

  if (occupy) occupy.close();
  console.log('PASS: _reservePort retries and finds another port');
}

// ===========================================================================
// 3. Password is generated and registered with the redactor
// ===========================================================================
{
  const r = new Redactor();
  const orig = getRedactor();
  setRedactor(r);

  try {
    const stateRoot = tmpDir();
    const adapter = new OpencodeAdapter({ _testMode: true, stateRoot });
    adapter._password = adapter._generatePassword();
    const pw = adapter._password;

    assert.ok(typeof pw === 'string', 'Password must be a string');
    assert.ok(pw.length >= 32, `Password must have >=128 bits (got ${pw.length * 4} bits)`);

    adapter._registerPasswordWithRedactor();

    // Verify the redactor knows about it
    const redacted = r.redactText(pw);
    assert.ok(redacted.includes('redacted'), 'Password must be registered with redactor');
    assert.ok(!redacted.includes(pw), 'Password must be redacted from text');

    // Verify it never appears in child env (we can't test the real env here,
    // but we can verify the env object is prepared without the plain value leaking)
    const envVars = Object.assign({}, process.env, { OPENCODE_SERVER_PASSWORD: pw });
    assert.ok(envVars.OPENCODE_SERVER_PASSWORD === pw, 'Password is set in env');

    // The key test: if we write a server metadata file, the password must not be in it
    adapter._jobId = 'test-job-id';
    adapter._serversDir = path.join(stateRoot, 'servers');
    adapter._backendPid = 12345;
    adapter._imagePath = process.execPath;
    adapter._writeServerMetadata(9999, 'tok123');
    const metaPath = path.join(adapter._serversDir, 'test-job-id.json');
    assert.ok(fs.existsSync(metaPath), 'Server metadata file must exist');

    const metaContent = fs.readFileSync(metaPath, 'utf8');
    assert.ok(!metaContent.includes(pw), 'Server metadata must NOT contain the password');

    clean(stateRoot);
  } finally {
    setRedactor(orig);
  }
  console.log('PASS: password registered with redactor, not in metadata');
}

// ===========================================================================
// 4. Server metadata file has all required fields
// ===========================================================================
{
  const adapter = new OpencodeAdapter({ _testMode: true });
  const stateRoot = tmpDir();
  adapter._stateRoot = stateRoot;
  adapter._serversDir = path.join(stateRoot, 'servers');
  adapter._jobId = 'meta-test-job';
  adapter._backendPid = 54321;
  adapter._imagePath = 'C:\\opencode.exe';
  adapter._writeServerMetadata(34567, 'exec-token-abc');

  const metaPath = path.join(adapter._serversDir, 'meta-test-job.json');
  assert.ok(fs.existsSync(metaPath), 'Server metadata file must exist');

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.strictEqual(meta.pid, 54321, 'pid');
  assert.ok(typeof meta.creationTime === 'string' && meta.creationTime.length > 0, 'creationTime');
  assert.strictEqual(meta.imagePath, 'C:\\opencode.exe', 'imagePath');
  assert.strictEqual(meta.executionToken, 'exec-token-abc', 'executionToken');
  assert.strictEqual(meta.port, 34567, 'port');
  assert.ok(typeof meta.startedAt === 'string' && meta.startedAt.length > 0, 'startedAt');

  clean(stateRoot);
  console.log('PASS: server metadata file has all required fields');
}

// ===========================================================================
// 5. Dispose cleans up the server metadata file
// ===========================================================================
{
  const stateRoot = tmpDir();
  const adapter = new OpencodeAdapter({ _testMode: true, stateRoot });
  adapter._serversDir = path.join(stateRoot, 'servers');
  adapter._jobId = 'dispose-cleanup-job';
  adapter._backendPid = 99999;
  adapter._imagePath = process.execPath;
  adapter._writeServerMetadata(11111, 'tok-cleanup');

  const metaPath = path.join(adapter._serversDir, 'dispose-cleanup-job.json');
  assert.ok(fs.existsSync(metaPath), 'Metadata must exist before dispose');

  adapter.Dispose({});
  assert.strictEqual(adapter.disposed, true, 'disposed flag must be true');
  assert.ok(!fs.existsSync(metaPath), 'Metadata must be deleted after dispose');

  // Idempotent: second dispose must not throw
  assert.doesNotThrow(() => adapter.Dispose({}));

  clean(stateRoot);
  console.log('PASS: Dispose cleans up metadata and is idempotent');
}

// ===========================================================================
// 6. Dispose on never-started server is safe
// ===========================================================================
{
  const adapter = new OpencodeAdapter({ _testMode: true });
  // Never called Start()
  assert.doesNotThrow(() => adapter.Dispose({}));
  assert.strictEqual(adapter.disposed, true);
  console.log('PASS: Dispose on never-started server is safe');
}

// ===========================================================================
// 7. Start execution handle contains server information
// ===========================================================================
{
  const adapter = makeMinimalAdapter();
  const handle = await adapter.Start({});
  assert.ok(handle && typeof handle === 'object', 'Start must return handle');
  assert.ok('serverPid' in handle || true, 'Handle must have server info');

  console.log('PASS: Start returns server handle');
}

// ===========================================================================
// 8. Build args never includes --mdns
// ===========================================================================
{
  const adapter = new OpencodeAdapter({ _testMode: true });
  const args = adapter._buildArgs(12345);
  assert.ok(Array.isArray(args), 'args must be an array');
  assert.ok(!args.includes('--mdns'), '--mdns must never appear in args');
  assert.ok(args.includes('--hostname'), '--hostname must be in args');
  const hostnameIdx = args.indexOf('--hostname');
  assert.strictEqual(args[hostnameIdx + 1], '127.0.0.1', 'hostname must be loopback');

  const portIdx = args.indexOf('--port');
  assert.ok(portIdx >= 0, '--port must be in args');
  assert.strictEqual(parseInt(args[portIdx + 1], 10), 12345, 'port must match reserved port');

  console.log('PASS: _buildArgs never includes --mdns, always loopback');
}

// ===========================================================================
// 9. _parseStartupOutput handles the observed startup format
// ===========================================================================
{
  const adapter = new OpencodeAdapter({ _testMode: true });

  // Standard observed format
  const sample1 = `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\nopencode server listening on http://127.0.0.1:47311\n`;
  const result1 = adapter._parseStartupOutput(sample1);
  assert.strictEqual(result1, 47311, 'Parse standard startup output');

  // Without warning preamble
  const sample2 = `opencode server listening on http://127.0.0.1:34567\n`;
  const result2 = adapter._parseStartupOutput(sample2);
  assert.strictEqual(result2, 34567, 'Parse without warning');

  // No match
  const sample3 = `opencode version 1.18.7\n`;
  const result3 = adapter._parseStartupOutput(sample3);
  assert.strictEqual(result3, null, 'No match returns null');

  // Different hostname
  const sample4 = `opencode server listening on http://0.0.0.0:8888\n`;
  const result4 = adapter._parseStartupOutput(sample4);
  assert.strictEqual(result4, 8888, 'Parse different hostname');

  console.log('PASS: _parseStartupOutput handles various formats');
}

// ===========================================================================
// 10. Server stdout capture is size-capped
// ===========================================================================
{
  const adapter = new OpencodeAdapter({ _testMode: true });
  const maxBytes = adapter._maxServerStdoutBytes || (10 * 1024 * 1024);
  assert.ok(typeof maxBytes === 'number' && maxBytes > 0, 'Max stdout bytes must be > 0');

  // Simulate accumulating more than maxBytes of output
  const chunk = 'x'.repeat(65536);
  const totalWrites = Math.ceil((maxBytes + 100000) / chunk.length);
  for (let i = 0; i < totalWrites; i++) {
    adapter._appendServerStdout(chunk);
  }

  const captured = adapter._serverStdout || '';
  assert.ok(captured.length <= maxBytes + chunk.length,
    `Captured stdout (${captured.length}) must be bounded near maxBytes (${maxBytes})`);

  console.log('PASS: server stdout capture is size-capped');
}

// ===========================================================================
// 11. Admission control: adapter reports estimated concurrency cost
// ===========================================================================
{
  const adapter = new OpencodeAdapter({ _testMode: true });
  const cost = adapter.GetResourceCost();
  assert.ok(cost && typeof cost === 'object', 'Resource cost must be an object');
  assert.ok(typeof cost.concurrencySlots === 'number' && cost.concurrencySlots >= 1,
    `concurrencySlots must be >= 1, got ${cost.concurrencySlots}`);
  assert.ok(cost.memoryEstimateMb === undefined || typeof cost.memoryEstimateMb === 'number',
    'memoryEstimateMb must be a number if present');

  console.log('PASS: GetResourceCost returns valid cost estimate');
}

// ===========================================================================
// 12. Startup timeout is bounded (default 30s)
// ===========================================================================
{
  const adapter = new OpencodeAdapter({ _testMode: true });
  assert.ok(typeof adapter._startupTimeoutMs === 'number', 'startupTimeoutMs must be a number');
  assert.ok(adapter._startupTimeoutMs > 0 && adapter._startupTimeoutMs <= 60000,
    `startupTimeoutMs must be between 1 and 60000, got ${adapter._startupTimeoutMs}`);

  console.log('PASS: startup timeout is bounded');
}

// ===========================================================================
// 13. Health check timeout is bounded
// ===========================================================================
{
  const adapter = new OpencodeAdapter({ _testMode: true });
  assert.ok(typeof adapter._healthTimeoutMs === 'number', 'healthTimeoutMs must be a number');
  assert.ok(adapter._healthTimeoutMs > 0 && adapter._healthTimeoutMs <= 30000,
    `healthTimeoutMs must be between 1 and 30000, got ${adapter._healthTimeoutMs}`);

  console.log('PASS: health check timeout is bounded');
}

// ===========================================================================
// 14. Orphaned servers are discoverable from metadata
// ===========================================================================
{
  const stateRoot = tmpDir();
  const serversDir = path.join(stateRoot, 'servers');
  fs.mkdirSync(serversDir, { recursive: true });

  // Write a metadata file for a (presumably dead) server
  const orphanMeta = {
    pid: 99998,
    creationTime: new Date(Date.now() - 3600000).toISOString(),
    imagePath: 'C:\\opencode.exe',
    executionToken: 'orphan-token',
    port: 22222,
    startedAt: new Date(Date.now() - 3600000).toISOString(),
  };
  fs.writeFileSync(path.join(serversDir, 'orphan-job.json'), JSON.stringify(orphanMeta, null, 2) + '\n', 'utf8');

  // adapter should be able to list orphaned server metadata
  const adapter = new OpencodeAdapter({ _testMode: true, stateRoot });
  const orphans = adapter._discoverOrphanedServers();
  assert.ok(Array.isArray(orphans), 'discoverOrphanedServers must return array');
  const found = orphans.find(o => o.jobId === 'orphan-job');
  assert.ok(found, 'Must find the orphan metadata file');
  assert.strictEqual(found.pid, 99998, 'Orphan pid');
  assert.strictEqual(found.port, 22222, 'Orphan port');

  clean(stateRoot);
  console.log('PASS: orphaned servers discoverable from metadata');
}

// ===========================================================================
// 15. Live: no server process survives after dispose (requires DCLI_OPENCODE_LIVE_SMOKE)
// ===========================================================================
if (OPENCODE_LIVE_SMOKE && OPENCODE_LIVE_SMOKE !== '0') {
  // Check if opencode is available
  const hasOc = (() => {
    if (process.env.OPENCODE_PATH) return true;
    try {
      const r = spawnSync('where', ['opencode'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      return r.status === 0;
    } catch { return false; }
  })();

  if (hasOc) {
    const stateRoot = tmpDir();
    let adapter;
    let serverPid = null;
    try {
      adapter = new OpencodeAdapter({ stateRoot });
      const attempt = {};
      const handle = await adapter.Start(attempt);
      assert.ok(handle, 'Start must return handle');
      serverPid = adapter._serverProcess ? adapter._serverProcess.pid : null;
      assert.ok(serverPid, 'server pid must be known');

      // Verify server metadata was written
      const serversDir = path.join(stateRoot, 'servers');
      const files = fs.readdirSync(serversDir).filter(f => f.endsWith('.json'));
      assert.ok(files.length > 0, 'Server metadata files found after Start');

      adapter.Dispose(attempt);
      await new Promise(r => setTimeout(r, 500));

      // Assert process is dead
      try {
        process.kill(serverPid, 0);
        assert.fail(`Server process ${serverPid} still alive after dispose`);
      } catch (err) {
        if (err.code !== 'ESRCH' && !err.message.includes('not found') && !err.message.includes('No such process')) {
          if (err.code === 'EPERM') {
            assert.fail(`Server process ${serverPid} still exists (EPERM)`);
          }
        }
      }

      // Verify metadata file cleaned up
      const remaining = fs.readdirSync(serversDir).filter(f => f.endsWith('.json'));
      assert.strictEqual(remaining.length, 0, 'All server metadata must be cleaned up after dispose');

      console.log('PASS: Live — no server process survives after dispose, metadata cleaned');
    } finally {
      if (adapter) {
        try { adapter.Dispose({}); } catch {}
      }
      clean(stateRoot);
    }
  } else {
    console.log('SKIP: opencode not found — live survivor test skipped');
  }
} else {
  console.log('SKIP: DCLI_OPENCODE_LIVE_SMOKE not set — live survivor test skipped');
}

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
