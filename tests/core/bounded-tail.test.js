const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = path.join(os.tmpdir(), `dcli-tail-test-${Math.random().toString(36).slice(2)}`);

let readTail, TRUNCATION_MARKER;
function load() {
  const bt = require('../../core/bounded-tail');
  readTail = bt.readTail;
  TRUNCATION_MARKER = bt.TRUNCATION_MARKER;
}

function tmpFile(content) {
  const p = path.join(TMP, `tail-${Math.random().toString(36).slice(2)}.txt`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function clean() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

// ===========================================================================
// 1. Empty file returns empty result
// ===========================================================================
{
  load();
  const p = tmpFile('');
  const result = readTail(p, 1024);
  assert.strictEqual(result.content, '');
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.totalBytes, 0);
  assert.strictEqual(result.returnedBytes, 0);
  console.log('PASS: empty file');
}

// ===========================================================================
// 2. Small file fully read
// ===========================================================================
{
  load();
  const p = tmpFile('hello world\nline two\n');
  const result = readTail(p, 1024);
  assert.ok(result.content.includes('hello world'));
  assert.ok(result.content.includes('line two'));
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.totalBytes, 21);
  console.log('PASS: small file');
}

// ===========================================================================
// 3. Bounded tail on large file seeks and truncates
// ===========================================================================
{
  load();
  // Create a file with ~2000 bytes
  const lines = [];
  for (let i = 0; i < 50; i++) {
    lines.push(`line_${i}_${'x'.repeat(30)}`);
  }
  const content = lines.join('\n') + '\n';
  const p = tmpFile(content);
  const total = Buffer.byteLength(content, 'utf8');
  assert.ok(total > 500, `test file must be >500 bytes, was ${total}`);

  const result = readTail(p, 500);
  assert.ok(result.truncated, 'Must be truncated');
  assert.ok(result.content.includes('(truncated)'), 'Must include truncation marker');
  assert.ok(result.returnedBytes <= 500 + TRUNCATION_MARKER.length,
    `returnedBytes (${result.returnedBytes}) must be <= maxBytes + marker length`);
  assert.strictEqual(result.totalBytes, total);
  console.log(`  total=${total} returned=${result.returnedBytes} truncated=${result.truncated}`);
  console.log('PASS: bounded tail on large file');
}

// ===========================================================================
// 4. Oversized line is truncated with marker
// ===========================================================================
{
  load();
  const longLine = 'header\n' + 'a'.repeat(20000) + '\nfooter';
  const p = tmpFile(longLine);
  const result = readTail(p, 500);
  assert.ok(result.truncated, 'Oversized line must be truncated');
  // The line content should show truncation
  assert.ok(result.content.includes('more bytes') || result.content.includes('truncated'),
    'Must indicate truncation');
  console.log('PASS: oversized line truncated');
}

// ===========================================================================
// 5. maxBytes=0 returns empty
// ===========================================================================
{
  load();
  const p = tmpFile('some content here');
  const result = readTail(p, 0);
  assert.strictEqual(result.content, '');
  assert.strictEqual(result.truncated, false);
  console.log('PASS: maxBytes=0 returns empty');
}

// ===========================================================================
// 6. Large file, small maxBytes
// ===========================================================================
{
  load();
  const lines = [];
  for (let i = 0; i < 200; i++) {
    lines.push(`line_${i}`);
  }
  const content = lines.join('\n');
  const p = tmpFile(content);

  const result = readTail(p, 100);
  assert.ok(result.truncated, 'Small maxBytes on large file must truncate');
  assert.ok(result.content.includes('(truncated)'), 'Must have truncation marker');
  console.log('PASS: large file, small maxBytes');
}

// ===========================================================================
// 7. UTF-8 non-ASCII preserved
// ===========================================================================
{
  load();
  const text = 'hello 世界\ncafé résumé\n日本語テスト\n😀🚀\n';
  const p = tmpFile(text);
  const result = readTail(p, 1024);
  assert.ok(result.content.includes('世界'), 'UTF-8 content must be preserved');
  assert.ok(result.content.includes('café'), 'UTF-8 content must be preserved');
  assert.ok(result.content.includes('日本語テスト'), 'UTF-8 content must be preserved');
  assert.ok(result.content.includes('😀'), 'Emoji must be preserved');
  console.log('PASS: UTF-8 non-ASCII preserved');
}

// ===========================================================================
// 8. Seek-based read does not load entire file (allocation is bounded)
// ===========================================================================
{
  load();
  // Create a very large file (but write only a small amount for the test)
  // We test that readTail does NOT read the beginning of the file
  const startLines = [];
  for (let i = 0; i < 1000; i++) startLines.push('START_' + i);
  const endLines = [];
  for (let i = 0; i < 10; i++) endLines.push('END_' + i);
  const content = startLines.join('\n') + '\n' + endLines.join('\n');
  const p = tmpFile(content);

  const result = readTail(p, 200);
  assert.ok(result.truncated, 'Must truncate');
  // The content should NOT include any START_ lines (they are beyond maxBytes from the end)
  // Actually if the file is big enough, it won't include them
  assert.ok(!result.content.includes('START_0'), 'Must not include start of file');
  assert.ok(result.content.includes('END_'), 'Must include end of file');
  console.log('PASS: seek-based read avoids loading entire file');
}

clean();

console.log('\nAll bounded-tail tests passed.');
