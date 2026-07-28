const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CORPUS_DIR = path.resolve(__dirname, '..', 'fixtures', 'findings-corpus');
const { parseFindings } = require('../../core/findings');

async function main() {

// ===========================================================================
// Corpus fixture tests — each file is a real-model-style output
// ===========================================================================

const files = fs.readdirSync(CORPUS_DIR).filter(f => f.endsWith('.md') && f !== 'README.md');
assert.ok(files.length >= 5, `Expected at least 5 corpus files, found ${files.length}`);

const expectations = {
  'clean-opencode.md': 'ok',
  'clean-codex.md': 'ok',
  'clean-claude.md': 'ok',
  'preamble-opencode.md': 'ok',
  'truncated-codex.md': 'malformed',
  'duplicate-claude.md': 'malformed',
};

for (const [file, expectedStatus] of Object.entries(expectations)) {
  const filePath = path.join(CORPUS_DIR, file);
  assert.ok(fs.existsSync(filePath), `Corpus file not found: ${file}`);

  const content = fs.readFileSync(filePath, 'utf8');
  const result = parseFindings(content);

  assert.strictEqual(
    result.status,
    expectedStatus,
    `Corpus "${file}": expected "${expectedStatus}", got "${result.status}" (error: ${result.error || 'none'})`
  );

  console.log(`PASS: corpus "${file}" → ${result.status}`);
}

console.log('\nAll corpus fixture tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
