const assert = require('node:assert');

// A spawnSync killed by its own `timeout` option reports `status: null` with
// `error.code === 'ETIMEDOUT'` — indistinguishable from a real crash unless
// checked. Report the test's own budget expiring, never "the child crashed".
function assertSpawnStatus(child, expectedStatus, message, budgetMs) {
  if (child.error && child.error.code === 'ETIMEDOUT') {
    assert.fail(
      `${message} — the child was killed by this test's own ${budgetMs ?? '?'} ms spawnSync timeout ` +
      '(error.code === "ETIMEDOUT"); the test budget expired, the child did not crash.',
    );
  }
  let detail = `status: ${child.status}`;
  if (child.error) detail += `, error: ${child.error.code}`;
  if (child.stderr) {
    const errText = String(child.stderr).trim();
    if (errText) detail += `, stderr: ${errText}`;
  }
  assert.strictEqual(child.status, expectedStatus, `${message} — ${detail}`);
}

module.exports = { assertSpawnStatus };
