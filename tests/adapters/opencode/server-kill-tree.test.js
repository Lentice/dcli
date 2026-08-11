// @suite quick
// @serial  temporarily overrides the shared lifecycle helper's export
//
// Windows server tree cleanup: kill() must delegate the whole-tree termination
// to the shared `terminateProcessTree` seam (which on Windows runs the
// verified taskkill-tree of ADR-010 rung 2, ticket 103). The seam itself is
// exercised for real by tests/adapters/windows-tree-kill.test.js; this test
// pins the opencode server's wiring to it. The @serial marker keeps the
// temporary export override from racing the parallel suite.
const assert = require('node:assert');

async function main() {
  if (process.platform !== 'win32') {
    console.log('SKIP: Windows server tree cleanup test skipped on non-Windows');
    return;
  }
  const lifecycle = require('../../../adapters/shared/process-lifecycle');
  const original = lifecycle.terminateProcessTree;
  let calledWith = null;

  lifecycle.terminateProcessTree = async (child) => {
    calledWith = child;
    return { kind: 'taskkill-tree', degraded: true, survivors: [] };
  };

  try {
    delete require.cache[require.resolve('../../../adapters/opencode/server')];
    const { OpencodeServer } = require('../../../adapters/opencode/server');
    const server = new OpencodeServer({});
    server._process = {
      pid: 12345,
      killed: false,
      exitCode: null,
      kill: () => { throw new Error('kill() must not be reached directly'); },
    };

    const result = await server.kill();
    assert.strictEqual(calledWith, server._process,
      'server.kill() must hand its child to the shared whole-tree termination helper');
    assert.strictEqual(result.kind, 'taskkill-tree',
      'the shared helper result must flow back to the caller');
    assert.strictEqual(result.degraded, true,
      'the Windows tree kill is a declared degraded capability');
    console.log('PASS: Windows server cleanup delegates to the shared taskkill-tree helper');
  } finally {
    lifecycle.terminateProcessTree = original;
  }
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
