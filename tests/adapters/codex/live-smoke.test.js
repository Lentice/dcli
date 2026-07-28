// @suite full
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const { CodexAdapter } = require('../../../adapters/codex/adapter');

async function main() {

// ===========================================================================
// Live smoke test — opt-in, skipped when Codex is not installed
// ===========================================================================
{
  let codexFound = false;
  try {
    const result = execSync('codex --version 2>nul || which codex 2>/dev/null', {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    const version = result.toString().trim();
    codexFound = !!version;
  } catch {}

  if (!codexFound) {
    console.log('SKIP: Codex CLI not found on PATH — skipping live smoke test');
    console.log('To run this test, install codex-cli: npm install -g @openai/codex');
    process.exit(0);
  }

  const adapter = new CodexAdapter();
  try {
    await adapter.LiveSmoke(30000);
    console.log('PASS: LiveSmoke succeeded');
  } catch (err) {
    assert.fail(`LiveSmoke failed: ${err.message}`);
  }
}

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
