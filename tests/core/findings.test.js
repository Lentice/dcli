const assert = require('node:assert');

async function main() {

// ===========================================================================
// 1. ok: clean findings with items
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  const text = `Some analysis text here.

Some more prose.

<!-- dcli:findings -->
\`\`\`json
{
  "verdict": "Minor style issues only.",
  "items": [
    { "severity": "minor", "file": "src/foo.js", "line": 42,
      "claim": "Unused variable",
      "evidence": "Variable x is declared but never read.",
      "suggested_fix": "Remove the declaration." }
  ]
}
\`\`\``;

  const result = parseFindings(text);
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.data.verdict, 'Minor style issues only.');
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].severity, 'minor');
  assert.strictEqual(result.items[0].file, 'src/foo.js');
  assert.strictEqual(result.items[0].line, 42);
  assert.strictEqual(result.proseBefore, 'Some analysis text here.\n\nSome more prose.\n\n');
  console.log('PASS: findings test 1 — clean findings parsed');
}

// ===========================================================================
// 2. absent: no marker in text
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  const text = `Here is some analysis with no findings appendix at all.`;
  const result = parseFindings(text);
  assert.strictEqual(result.status, 'absent');
  assert.strictEqual(result.data, null);
  assert.strictEqual(result.items, null);
  console.log('PASS: findings test 2 — absent findings when no marker');
}

// ===========================================================================
// 3. preamble tolerated before marker
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  const text = `Here is my analysis:

The code looks good overall.

<!-- dcli:findings -->
\`\`\`json
{
  "verdict": "No issues.",
  "items": []
}
\`\`\``;

  const result = parseFindings(text);
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.data.verdict, 'No issues.');
  assert.strictEqual(result.items.length, 0);
  console.log('PASS: findings test 3 — preamble tolerated');
}

// ===========================================================================
// 4. trailing content after appendix is rejected
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  const text = `Analysis text.

<!-- dcli:findings -->
\`\`\`json
{
  "verdict": "Looks fine.",
  "items": []
}
\`\`\`

This should not be here.`;

  const result = parseFindings(text);
  assert.strictEqual(result.status, 'malformed');
  assert.ok(result.error.toLowerCase().includes('trailing'), `Error must mention trailing: ${result.error}`);
  console.log('PASS: findings test 4 — trailing content rejected');
}

// ===========================================================================
// 5. duplicate marker is malformed
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  const text = `Analysis.

<!-- dcli:findings -->
\`\`\`json
{ "verdict": "First.", "items": [] }
\`\`\`

More text.

<!-- dcli:findings -->
\`\`\`json
{ "verdict": "Second.", "items": [] }
\`\`\``;

  const result = parseFindings(text);
  assert.strictEqual(result.status, 'malformed');
  assert.ok(result.error.toLowerCase().includes('duplicate'), `Error must mention duplicate: ${result.error}`);
  console.log('PASS: findings test 5 — duplicate marker is malformed');
}

// ===========================================================================
// 6. single-element top-level array is not mis-enumerated
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  const text = `Analysis.

<!-- dcli:findings -->
\`\`\`json
{
  "verdict": "Single item.",
  "items": [
    { "severity": "critical", "file": "src/bad.js", "line": 10,
      "claim": "Security issue",
      "evidence": "SQL injection possible.",
      "suggested_fix": "Use parameterized queries." }
  ]
}
\`\`\``;

  const result = parseFindings(text);
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].severity, 'critical');
  assert.strictEqual(result.items[0].file, 'src/bad.js');
  console.log('PASS: findings test 6 — single-element array correct');
}

// ===========================================================================
// 7. line number > int32 does not crash parser
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  const text = `Analysis.

<!-- dcli:findings -->
\`\`\`json
{
  "verdict": "Big line.",
  "items": [
    { "severity": "minor", "file": "src/huge.js", "line": 9999999999,
      "claim": "Long file",
      "evidence": "File is very long." }
  ]
}
\`\`\``;

  const result = parseFindings(text);
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.items[0].line, 9999999999);
  console.log('PASS: findings test 7 — line number > int32 accepted');
}

// ===========================================================================
// 8. inline code fences inside prose do not break segmentation
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  const text = `Analysis with \`inline code\` and \`\`\` not really a fence \`\`\` in prose.

<!-- dcli:findings -->
\`\`\`json
{
  "verdict": "Fences fine.",
  "items": []
}
\`\`\``;

  const result = parseFindings(text);
  assert.strictEqual(result.status, 'ok');
  console.log('PASS: findings test 8 — inline code fences handled');
}

// ===========================================================================
// 9. truncated JSON is malformed
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  const text = `Analysis.

<!-- dcli:findings -->
\`\`\`json
{ "verdict": "Truncated", "items": [ { "severity": "critical", "file": "a.js", "li`;

  const result = parseFindings(text);
  assert.strictEqual(result.status, 'malformed');
  assert.ok(result.error.toLowerCase().includes('truncat') || result.error.toLowerCase().includes('parse'), `Error must mention truncation/parse: ${result.error}`);
  console.log('PASS: findings test 9 — truncated JSON is malformed');
}

// ===========================================================================
// 10. oversized appendix is malformed
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  // Build a huge items array to exceed the cap
  const hugeItems = [];
  for (let i = 0; i < 200; i++) {
    hugeItems.push({ severity: 'minor', file: 'src/big.js', line: i, claim: 'X'.repeat(1000) });
  }
  const hugeJson = JSON.stringify({ verdict: 'Too many.', items: hugeItems });
  const text = `Analysis.

<!-- dcli:findings -->
\`\`\`json
${hugeJson}
\`\`\``;

  const result = parseFindings(text);
  assert.strictEqual(result.status, 'malformed');
  const err10 = result.error.toLowerCase();
  assert.ok(err10.includes('size') || err10.includes('item'), `Error must mention size/items: ${result.error}`);
  console.log('PASS: findings test 10 — oversized appendix is malformed');
}

// ===========================================================================
// 11. absolute path is rejected
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  const text = `Analysis.

<!-- dcli:findings -->
\`\`\`json
{
  "verdict": "Absolute path.",
  "items": [
    { "severity": "minor", "file": "/etc/passwd", "line": 1,
      "claim": "Absolute path used",
      "evidence": "Should be relative." }
  ]
}
\`\`\``;

  const result = parseFindings(text);
  assert.strictEqual(result.status, 'malformed');
  const err11 = result.error.toLowerCase();
  assert.ok(err11.includes('absolute') || err11.includes('path'), `Error must mention absolute/path: ${result.error}`);
  console.log('PASS: findings test 11 — absolute path rejected');
}

// ===========================================================================
// 12. traversal path is rejected
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  const text = `Analysis.

<!-- dcli:findings -->
\`\`\`json
{
  "verdict": "Traversal path.",
  "items": [
    { "severity": "minor", "file": "../../etc/passwd", "line": 1,
      "claim": "Path traversal",
      "evidence": "Should not escape repo." }
  ]
}
\`\`\``;

  const result = parseFindings(text);
  assert.strictEqual(result.status, 'malformed');
  const err12 = result.error.toLowerCase();
  assert.ok(err12.includes('traversal') || err12.includes('path'), `Error must mention traversal/path: ${result.error}`);
  console.log('PASS: findings test 12 — traversal path rejected');
}

// ===========================================================================
// 13. malformed appendix never reads as clean (regression)
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  // Completely broken JSON after marker
  const text = `Analysis.

<!-- dcli:findings -->
\`\`\`json
{ broken json here
\`\`\``;

  const result = parseFindings(text);
  assert.strictEqual(result.status, 'malformed', 'Malformed JSON must not be ok');
  assert.strictEqual(result.status !== 'ok', true, 'Malformed must never be ok');
  // Also verify the prose is preserved
  assert.ok(result.proseBefore.includes('Analysis'), 'prose must be preserved');
  console.log('PASS: findings test 13 — malformed never reads as clean');
}

// ===========================================================================
// 14. result.md prose is preserved in every failure case
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  // even with malformed content, proseBefore should have everything before the marker
  const text = `Important analysis content that must survive.

Even with multiple paragraphs.

<!-- dcli:findings -->
\`\`\`json
{ BAD
\`\`\``;

  const result = parseFindings(text);
  assert.ok(result.proseBefore.includes('Important analysis content'));
  assert.ok(result.proseBefore.includes('multiple paragraphs'));
  assert.strictEqual(result.status, 'malformed');
  console.log('PASS: findings test 14 — prose preserved on malformed');
}

// ===========================================================================
// 15. findings_status is exposed: ok, absent, malformed
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');

  const ok = parseFindings('x\n\n<!-- dcli:findings -->\n```json\n{"verdict":"v","items":[]}\n```');
  assert.strictEqual(ok.status, 'ok');

  const absent = parseFindings('just prose');
  assert.strictEqual(absent.status, 'absent');

  const malformed = parseFindings('x\n\n<!-- dcli:findings -->\n```json\n{BAD\n```');
  assert.strictEqual(malformed.status, 'malformed');

  console.log('PASS: findings test 15 — three status values ok');
}

// ===========================================================================
// 16. empty verdict is rejected
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  const text = `Analysis.

<!-- dcli:findings -->
\`\`\`json
{
  "verdict": "",
  "items": []
}
\`\`\``;

  const result = parseFindings(text);
  assert.strictEqual(result.status, 'malformed');
  assert.ok(result.error.toLowerCase().includes('verdict'), `Error must mention verdict: ${result.error}`);
  console.log('PASS: findings test 16 — empty verdict rejected');
}

// ===========================================================================
// 17. unknown severity rejected
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  const text = `Analysis.

<!-- dcli:findings -->
\`\`\`json
{
  "verdict": "Bad severity.",
  "items": [
    { "severity": "catastrophic", "file": "x.js", "line": 1,
      "claim": "Bad severity" }
  ]
}
\`\`\``;

  const result = parseFindings(text);
  assert.strictEqual(result.status, 'malformed');
  assert.ok(result.error.toLowerCase().includes('severity'), `Error must mention severity: ${result.error}`);
  console.log('PASS: findings test 17 — unknown severity rejected');
}

// ===========================================================================
// 18. empty claim rejected
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  const text = `Analysis.

<!-- dcli:findings -->
\`\`\`json
{
  "verdict": "Empty claim.",
  "items": [
    { "severity": "minor", "file": "x.js", "line": 1,
      "claim": "" }
  ]
}
\`\`\``;

  const result = parseFindings(text);
  assert.strictEqual(result.status, 'malformed');
  assert.ok(result.error.toLowerCase().includes('claim'), `Error must mention claim: ${result.error}`);
  console.log('PASS: findings test 18 — empty claim rejected');
}

// ===========================================================================
// Summary
// ===========================================================================
console.log('\nAll findings parser tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
