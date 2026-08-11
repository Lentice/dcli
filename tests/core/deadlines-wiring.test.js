// Call-site tests for ticket 109: the deadlines table is not just a table —
// each wired key's DEFAULTS/env-override behavior must be observable at its
// production consumer, so a future local re-declaration (a bare `const X =
// 3000` shadowing resolveDeadline) fails this suite instead of shipping
// invisible until it hangs.
const assert = require('node:assert');
const http = require('node:http');
const { LockManager } = require('../../core/locking');
const { resolveDeadline } = require('../../core/deadlines');

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function main() {
  // ===========================================================================
  // A. POST_EXIT_DRAIN_MS: DCLI_POST_EXIT_DRAIN changes process-lifecycle's
  // effective drain bound.
  // ===========================================================================
  {
    const { applyProcessLifecycle } = require('../../adapters/shared/process-lifecycle');
    class Fake {}
    applyProcessLifecycle(Fake);
    const instance = new Fake();
    instance._stdoutClosed = false;
    instance._stderrClosed = false;
    instance._facts = [];

    process.env.DCLI_POST_EXIT_DRAIN = '80';
    try {
      const started = Date.now();
      await instance._waitForStreamDrain();
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 80 && elapsed < 2000, `drain must bound on the env override, got ${elapsed}ms`);
      assert.ok(instance._drainTimedOut, 'drain must time out when streams never close');
      assert.ok(instance._facts.some(f => f.type === 'drain_timeout'), 'a drain_timeout fact must be recorded');
    } finally {
      delete process.env.DCLI_POST_EXIT_DRAIN;
    }
    console.log('PASS: DCLI_POST_EXIT_DRAIN changes process-lifecycle drain bound');
  }

  // ===========================================================================
  // B. HTTP_CONNECT_MS / HTTP_READ_MS: DCLI_HTTP_CONNECT_TIMEOUT and
  // DCLI_HTTP_READ_TIMEOUT bound the opencode transport independently, with no
  // explicit timeoutMs supplied.
  // ===========================================================================
  {
    const { HttpTransport, requestJson } = require('../../adapters/opencode/transport');

    // B1. A tiny read bound times out even though the connection was instant.
    const pending = [];
    const { server, port } = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      pending.push(res); // never write the body
    });
    process.env.DCLI_HTTP_CONNECT_TIMEOUT = '5000';
    process.env.DCLI_HTTP_READ_TIMEOUT = '80';
    try {
      const transport = new HttpTransport({ baseUrl: `http://127.0.0.1:${port}` });
      const started = Date.now();
      await assert.rejects(() => requestJson(transport, { method: 'GET', path: '/slow-body' }));
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 3000, `read bound must fire, not the 5s connect bound, got ${elapsed}ms`);
    } finally {
      delete process.env.DCLI_HTTP_CONNECT_TIMEOUT;
      delete process.env.DCLI_HTTP_READ_TIMEOUT;
      for (const res of pending) { try { res.destroy(); } catch {} }
      await close(server);
    }
    console.log('PASS: DCLI_HTTP_READ_TIMEOUT bounds the body read independently of connect');

    // B2. A tiny connect bound times out against a non-routable address
    // (192.0.2.0/24, RFC 5737 TEST-NET-1 — guaranteed never to answer), whose
    // real OS-level connect attempt would otherwise hang far longer than the
    // 5 s read bound.
    process.env.DCLI_HTTP_CONNECT_TIMEOUT = '80';
    process.env.DCLI_HTTP_READ_TIMEOUT = '5000';
    try {
      const transport = new HttpTransport({ baseUrl: 'http://192.0.2.1:81' });
      const started = Date.now();
      await assert.rejects(() => requestJson(transport, { method: 'GET', path: '/unreachable' }));
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 3000, `connect bound must fire, not the 5s read bound, got ${elapsed}ms`);
    } finally {
      delete process.env.DCLI_HTTP_CONNECT_TIMEOUT;
      delete process.env.DCLI_HTTP_READ_TIMEOUT;
    }
    console.log('PASS: DCLI_HTTP_CONNECT_TIMEOUT bounds connection establishment independently of read');
  }

  // ===========================================================================
  // C. LOCK_ACQUISITION_MS: a LockManager built without an explicit timeoutMs
  // takes its default from resolveDeadline, not a local re-declaration.
  // ===========================================================================
  {
    const lm = new LockManager({ lockDir: require('node:os').tmpdir() });
    assert.strictEqual(lm._timeoutMs, resolveDeadline('LOCK_ACQUISITION_MS'));
  }
  console.log('PASS: LockManager default timeout is resolveDeadline(\'LOCK_ACQUISITION_MS\')');

  console.log('\nAll deadlines-wiring tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
