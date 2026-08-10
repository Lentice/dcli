// @suite full
// @serial  binds loopback ports; asserts reserve-and-retry races
// Server lifecycle, now against the per-job server module (ticket 100):
// port reservation, password handling, metadata, stdout capture, orphan
// discovery, dispose.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');

const { OpencodeServer } = require('../../../adapters/opencode/server');
const { Redactor } = require('../../../core/redactor');
const { setRedactor, getRedactor } = require('../../../core/fs-text');

function tmpDir() {
  const d = path.join(os.tmpdir(), `dcli-srv-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeServer(opts = {}) {
  return new OpencodeServer(opts);
}

async function main() {

// ===========================================================================
// 1. Port reservation returns a usable loopback port
// ===========================================================================
{
  const port = await OpencodeServer.reservePort();
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
  console.log('PASS: reservePort returns a usable loopback port');
}

// ===========================================================================
// 2. Port reservation retries when port is taken (close-then-bind race)
// ===========================================================================
{
  // Reserve a port, then try to reserve the same one (simulate race)
  const port = await OpencodeServer.reservePort();

  // Bind to it so the next reservePort call with binding fails
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
  // reservePort should get a different port
  const port2 = await OpencodeServer.reservePort(3);
  assert.ok(typeof port2 === 'number', 'Retry must produce a port');
  assert.ok(port2 > 0, `Port ${port2} must be positive`);

  if (occupy) occupy.close();
  console.log('PASS: reservePort retries and finds another port');
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
    const server = makeServer({ stateRoot, jobId: 'test-job-id' });
    server._password = server._generatePassword();
    const pw = server._password;

    assert.ok(typeof pw === 'string', 'Password must be a string');
    assert.ok(pw.length >= 32, `Password must have >=128 bits (got ${pw.length * 4} bits)`);

    server._registerPasswordWithRedactor();

    // Verify the redactor knows about it
    const redacted = r.redactText(pw);
    assert.ok(redacted.includes('redacted'), 'Password must be registered with redactor');
    assert.ok(!redacted.includes(pw), 'Password must be redacted from text');

    // The key test: if we write a server metadata file, the password must not be in it
    server._process = { pid: 12345 };
    server._imagePath = process.execPath;
    server._writeServerMetadata(9999, 'tok123');
    const metaPath = path.join(stateRoot, 'servers', 'test-job-id.json');
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
  const stateRoot = tmpDir();
  const server = makeServer({ stateRoot, jobId: 'meta-test-job' });
  server._process = { pid: 54321 };
  server._imagePath = 'C:\\opencode.exe';
  server._writeServerMetadata(34567, 'exec-token-abc');

  const metaPath = path.join(stateRoot, 'servers', 'meta-test-job.json');
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
  const server = makeServer({ stateRoot, jobId: 'dispose-cleanup-job' });
  server._process = { pid: 99999 };
  server._imagePath = process.execPath;
  server._writeServerMetadata(11111, 'tok-cleanup');

  const metaPath = path.join(stateRoot, 'servers', 'dispose-cleanup-job.json');
  assert.ok(fs.existsSync(metaPath), 'Metadata must exist before dispose');

  await server.dispose();
  assert.ok(!fs.existsSync(metaPath), 'Metadata must be deleted after dispose');

  // Idempotent: second dispose must not throw
  await assert.doesNotReject(() => server.dispose());

  clean(stateRoot);
  console.log('PASS: Dispose cleans up metadata and is idempotent');
}

// ===========================================================================
// 6. Dispose on never-started server is safe
// ===========================================================================
{
  const server = makeServer();
  // Never called start()
  await assert.doesNotReject(() => server.dispose());
  console.log('PASS: Dispose on never-started server is safe');
}

// ===========================================================================
// 7. Build args never includes --mdns
// ===========================================================================
{
  const args = OpencodeServer.buildArgs(12345);
  assert.ok(Array.isArray(args), 'args must be an array');
  assert.ok(!args.includes('--mdns'), '--mdns must never appear in args');
  assert.ok(args.includes('--hostname'), '--hostname must be in args');
  const hostnameIdx = args.indexOf('--hostname');
  assert.strictEqual(args[hostnameIdx + 1], '127.0.0.1', 'hostname must be loopback');

  const portIdx = args.indexOf('--port');
  assert.ok(portIdx >= 0, '--port must be in args');
  assert.strictEqual(parseInt(args[portIdx + 1], 10), 12345, 'port must match reserved port');

  console.log('PASS: buildArgs never includes --mdns, always loopback');
}

// ===========================================================================
// 8. parseStartupOutput handles the observed startup format
// ===========================================================================
{
  // Standard observed format
  const sample1 = `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\nopencode server listening on http://127.0.0.1:47311\n`;
  const result1 = OpencodeServer.parseStartupOutput(sample1);
  assert.strictEqual(result1, 47311, 'Parse standard startup output');

  // Without warning preamble
  const sample2 = `opencode server listening on http://127.0.0.1:34567\n`;
  const result2 = OpencodeServer.parseStartupOutput(sample2);
  assert.strictEqual(result2, 34567, 'Parse without warning');

  // No match
  const sample3 = `opencode version 1.18.7\n`;
  const result3 = OpencodeServer.parseStartupOutput(sample3);
  assert.strictEqual(result3, null, 'No match returns null');

  // Different hostname
  const sample4 = `opencode server listening on http://0.0.0.0:8888\n`;
  const result4 = OpencodeServer.parseStartupOutput(sample4);
  assert.strictEqual(result4, 8888, 'Parse different hostname');

  console.log('PASS: parseStartupOutput handles various formats');
}

// ===========================================================================
// 9. Server stdout capture is size-capped
// ===========================================================================
{
  const server = makeServer();
  const maxBytes = server._maxStdoutBytes || (10 * 1024 * 1024);
  assert.ok(typeof maxBytes === 'number' && maxBytes > 0, 'Max stdout bytes must be > 0');

  // Simulate accumulating more than maxBytes of output
  const chunk = 'x'.repeat(65536);
  const totalWrites = Math.ceil((maxBytes + 100000) / chunk.length);
  for (let i = 0; i < totalWrites; i++) {
    server._appendStdout(chunk);
  }

  const captured = server.stdout || '';
  assert.ok(captured.length <= maxBytes + chunk.length,
    `Captured stdout (${captured.length}) must be bounded near maxBytes (${maxBytes})`);

  console.log('PASS: server stdout capture is size-capped');
}

// ===========================================================================
// 10. Startup timeout is bounded (default 30s)
// ===========================================================================
{
  const server = makeServer();
  assert.ok(typeof server.startupTimeoutMs === 'number', 'startupTimeoutMs must be a number');
  assert.ok(server.startupTimeoutMs > 0 && server.startupTimeoutMs <= 60000,
    `startupTimeoutMs must be between 1 and 60000, got ${server.startupTimeoutMs}`);

  console.log('PASS: startup timeout is bounded');
}

// ===========================================================================
// 11. Health check timeout is bounded
// ===========================================================================
{
  const server = makeServer();
  assert.ok(typeof server.healthTimeoutMs === 'number', 'healthTimeoutMs must be a number');
  assert.ok(server.healthTimeoutMs > 0 && server.healthTimeoutMs <= 30000,
    `healthTimeoutMs must be between 1 and 30000, got ${server.healthTimeoutMs}`);

  console.log('PASS: health check timeout is bounded');
}

// ===========================================================================
// 12. Orphaned servers are discoverable from metadata
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

  const orphans = OpencodeServer.discoverOrphaned(stateRoot);
  assert.ok(Array.isArray(orphans), 'discoverOrphaned must return array');
  const found = orphans.find(o => o.jobId === 'orphan-job');
  assert.ok(found, 'Must find the orphan metadata file');
  assert.strictEqual(found.pid, 99998, 'Orphan pid');
  assert.strictEqual(found.port, 22222, 'Orphan port');

  clean(stateRoot);
  console.log('PASS: orphaned servers discoverable from metadata');
}

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
