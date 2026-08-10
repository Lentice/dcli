// @suite full
// Criterion E for ticket 98 (split core/commands/index.js): every CLI error
// message and exit code is unchanged by the refactor. This test re-runs a
// fixed set of invalid/valid invocations captured BEFORE the change (see
// tests/fixtures/cli-golden/cases.json) and byte-compares stdout, stderr and
// exit code against the fixture.
//
// The fixture stores raw child-process buffers as base64, so the comparison
// is on bytes, not on decoded text. The one normalization: the job-not-found
// case embeds the repo key, a sha256 of the machine temp path, as
// {{REPO_KEY}}; this test recomputes it for the same fixed path and
// substitutes it before comparing. Everything else is compared verbatim.
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { computeRepoKeyWithPath } = require('../../core/repo-key');

const CLI = path.resolve(__dirname, '../../cli/dcli.js');
const FIXTURE = path.resolve(__dirname, '../fixtures/cli-golden/cases.json');
const REPO_PATH = path.join(os.tmpdir(), 'dcli-golden-repo');
const MAX_BUDGET_MS = 60_000;

async function main() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

  // The job-not-found case embeds the repo key for the fixed --repo path.
  const { repoKey } = computeRepoKeyWithPath(REPO_PATH);
  // Fixture stores raw buffers as base64; decode for comparison (all captured
  // output is UTF-8). The repo key is substituted after decoding — it is a
  // sha256 of the machine temp path, so the fixture cannot carry it literally.
  const expand = (b64) => Buffer.from(b64, 'base64').toString('utf8').replace(/{{REPO_KEY}}/g, repoKey);

  for (const c of fixture.cases) {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-golden-state-'));
    try {
      const r = spawnSync(process.execPath, [CLI, ...c.args], {
        cwd: path.resolve(__dirname, '../..'),
        env: { ...process.env, DCLI_STATE_ROOT: stateRoot },
        windowsHide: true,
        timeout: MAX_BUDGET_MS,
      });

      const stdoutText = Buffer.from(r.stdout).toString('utf8');
      const stderrText = Buffer.from(r.stderr).toString('utf8');
      assert.strictEqual(stdoutText, Buffer.from(c.stdoutB64, 'base64').toString('utf8'),
        `[${c.name}] stdout differs from the pre-refactor capture.\n` +
        `  args: ${JSON.stringify(c.args)}\n` +
        `  expected: ${JSON.stringify(Buffer.from(c.stdoutB64, 'base64').toString('utf8'))}\n` +
        `  actual:   ${JSON.stringify(stdoutText)}`);
      assert.strictEqual(stderrText, expand(c.stderrB64),
        `[${c.name}] stderr differs from the pre-refactor capture.\n` +
        `  args: ${JSON.stringify(c.args)}\n` +
        `  expected: ${JSON.stringify(expand(c.stderrB64))}\n` +
        `  actual:   ${JSON.stringify(stderrText)}`);
      assert.strictEqual(r.status, c.exitCode,
        `[${c.name}] exit code differs from the pre-refactor capture: expected ${c.exitCode}, got ${r.status}`);
      console.log(`PASS: golden ${c.name} (exit ${r.status})`);
    } finally {
      try { fs.rmSync(stateRoot, { recursive: true, force: true }); } catch {}
    }
  }
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
