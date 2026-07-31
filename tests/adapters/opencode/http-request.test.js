// Real-server coverage for the opencode adapter's HTTP transport.
//
// Every other opencode test drives _transportRequest through a test-mode
// override, so httpRequest itself is executed by nothing. It carries the
// contract the failure classifier and the 404 probes depend on — parsed JSON
// on 2xx, statusCode/body on the error, classHint on a CreditsError, and a
// bounded timeout — so it gets one test against an actual socket.

const assert = require('node:assert');
const http = require('node:http');
const { httpRequest } = require('../../../adapters/opencode/adapter');

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
  // 1. 2xx JSON is parsed; auth header and body reach the server
  {
    let seen = null;
    const { server, port } = await listen((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        seen = { auth: req.headers.authorization, ct: req.headers['content-type'], body, method: req.method };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'ses_1' }));
      });
    });
    try {
      const out = await httpRequest('POST', `http://127.0.0.1:${port}/session`, { parts: [1] }, 5000, 'pw');
      assert.deepStrictEqual(out, { id: 'ses_1' }, 'JSON body must be parsed');
      assert.strictEqual(seen.method, 'POST');
      assert.strictEqual(seen.body, '{"parts":[1]}', 'request body must be sent as JSON');
      assert.strictEqual(seen.ct, 'application/json');
      assert.strictEqual(seen.auth, 'Basic ' + Buffer.from('opencode:pw').toString('base64'));
    } finally {
      await close(server);
    }
    console.log('PASS: 2xx JSON parsed, auth and body sent');
  }

  // 2. Non-JSON 2xx returns the raw text (204 has none at all)
  {
    const { server, port } = await listen((req, res) => { res.writeHead(204); res.end(); });
    try {
      const out = await httpRequest('POST', `http://127.0.0.1:${port}/prompt_async`, { a: 1 }, 5000, null);
      assert.strictEqual(out, '', '204 must yield the empty raw body, not a throw');
    } finally {
      await close(server);
    }
    console.log('PASS: empty 204 body classified, not thrown');
  }

  // 3. Non-2xx rejects with statusCode and body attached
  {
    const { server, port } = await listen((req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"nope"}');
    });
    try {
      await assert.rejects(
        () => httpRequest('GET', `http://127.0.0.1:${port}/session/x`, null, 5000, null),
        (err) => {
          assert.ok(!(err instanceof ReferenceError) && !(err instanceof TypeError),
            `programmer error, not the failure under test: ${err && err.stack}`);
          assert.strictEqual(err.statusCode, 404, 'statusCode must be attached — the 404 probes branch on it');
          assert.strictEqual(err.body, '{"error":"nope"}');
          assert.ok(/^HTTP 404 from GET /.test(err.message), `unexpected message: ${err.message}`);
          return true;
        }
      );
    } finally {
      await close(server);
    }
    console.log('PASS: non-2xx carries statusCode and body');
  }

  // 4. CreditsError payload sets the quota class hint
  {
    const { server, port } = await listen((req, res) => {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'CreditsError' } }));
    });
    try {
      await assert.rejects(
        () => httpRequest('GET', `http://127.0.0.1:${port}/x`, null, 5000, null),
        (err) => {
          assert.strictEqual(err.classHint, 'quota_or_rate_limit');
          return true;
        }
      );
    } finally {
      await close(server);
    }
    console.log('PASS: CreditsError maps to quota_or_rate_limit');
  }

  // 5. A server that never responds is bounded by the supplied timeout
  {
    const sockets = [];
    const { server, port } = await listen((req, res) => { sockets.push(res); /* never respond */ });
    try {
      const started = Date.now();
      await assert.rejects(
        () => httpRequest('GET', `http://127.0.0.1:${port}/hang`, null, 300, null),
        (err) => {
          assert.ok(!(err instanceof ReferenceError) && !(err instanceof TypeError),
            `programmer error, not the failure under test: ${err && err.stack}`);
          assert.ok(/timed out after 300ms/.test(err.message), `unexpected message: ${err.message}`);
          return true;
        }
      );
      assert.ok(Date.now() - started < 5000, 'timeout must fire on the supplied budget, not a default');
    } finally {
      for (const res of sockets) { try { res.destroy(); } catch {} }
      await close(server);
    }
    console.log('PASS: unresponsive server bounded by supplied timeout');
  }

  console.log('\nAll opencode httpRequest tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
