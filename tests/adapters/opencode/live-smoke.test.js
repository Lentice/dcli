// @suite full
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OPENCODE_LIVE_SMOKE = process.env.DCLI_OPENCODE_LIVE_SMOKE;

async function main() {
  if (!OPENCODE_LIVE_SMOKE || OPENCODE_LIVE_SMOKE === '0') {
    console.log('SKIP: DCLI_OPENCODE_LIVE_SMOKE not set — live smoke test skipped');
    console.log('      Set DCLI_OPENCODE_LIVE_SMOKE=1 to run against a real opencode install.');
    return;
  }

  const opencodePath = resolveOpencode();
  if (!opencodePath) {
    console.log('SKIP: opencode not found on PATH — live smoke test skipped');
    return;
  }

  const dcliOpencode = path.join(ROOT, 'cli', 'dcli-opencode.js');
  const result = spawnSync(process.execPath, [
    dcliOpencode, 'run',
    '--hard-timeout-sec', '60',
    '--model', 'opencode-go/deepseek-v4-flash',
    'Reply with exactly: PONG',
  ], {
    timeout: 70_000,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env },
  });

  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();

  assert.strictEqual(
    result.status, 0,
    `Expected exit 0 for live smoke run, got ${result.status}\nstdout: ${stdout}\nstderr: ${stderr}`
  );

  assert.ok(
    stdout.length > 0,
    `Expected non-empty stdout from live smoke run\nexit: ${result.status}\nstdout: ${stdout}\nstderr: ${stderr}`
  );

  console.log('PASS: live smoke run returned non-empty text (exit 0)');
}

function resolveOpencode() {
  if (process.env.OPENCODE_PATH) return process.env.OPENCODE_PATH;
  try {
    const result = spawnSync('where', ['opencode'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (result.status === 0) {
      const line = (result.stdout || '').trim().split('\n')[0].trim();
      if (line) return line;
    }
  } catch {}
  try {
    const result = spawnSync('which', ['opencode'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (result.status === 0) {
      const line = (result.stdout || '').trim().split('\n')[0].trim();
      if (line) return line;
    }
  } catch {}
  return null;
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
