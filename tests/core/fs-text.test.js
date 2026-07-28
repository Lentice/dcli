const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeTextFileAtomic, writeJsonFileAtomic, appendJsonLine, setRedactor, getRedactor } = require('../../core/fs-text');
const { Redactor } = require('../../core/redactor');

const TMP = path.join(os.tmpdir(), 'dcli-fs-test');

/**
 * @returns {string}
 */
function tmpFile() {
  fs.mkdirSync(TMP, { recursive: true });
  return path.join(TMP, `test-${Math.random().toString(36).slice(2)}`);
}

function hasBom(buf) {
  return buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
}

{
  const p = tmpFile();
  writeTextFileAtomic(p, 'hello');
  const buf = fs.readFileSync(p);
  assert.strictEqual(hasBom(buf), false, 'writeTextFileAtomic must not produce BOM');
  assert.strictEqual(buf.toString('utf8'), 'hello');
}

{
  const p = tmpFile();
  writeJsonFileAtomic(p, { hello: 'world' });
  const content = fs.readFileSync(p, 'utf8');
  assert.strictEqual(hasBom(Buffer.from(content, 'utf8')), false, 'writeJsonFileAtomic must not produce BOM');
  assert.strictEqual(content, '{\n  "hello": "world"\n}\n');
}

{
  const p = tmpFile();
  appendJsonLine(p, { a: 1 });
  const content = fs.readFileSync(p, 'utf8');
  assert.strictEqual(hasBom(Buffer.from(content, 'utf8')), false, 'appendJsonLine must not produce BOM');
  assert.strictEqual(content, '{"a":1}\n');
}

{
  const p = tmpFile();
  writeJsonFileAtomic(p, { b: 2, a: 1 });
  const content = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(content);
  assert.deepStrictEqual(parsed, { a: 1, b: 2 });
  const keys = Object.keys(parsed);
  assert.deepStrictEqual(keys, ['a', 'b']);
}

{
  const p = tmpFile();
  writeJsonFileAtomic(p, { x: 1 });
  const dir = path.dirname(p);
  const base = path.basename(p);
  const leftovers = fs.readdirSync(dir).filter(f => f.startsWith(base + '.tmp-'));
  assert.strictEqual(leftovers.length, 0, `expected no .tmp- files, found: ${leftovers.join(', ')}`);
}

{
  const p = tmpFile();
  appendJsonLine(p, { a: 1 });
  appendJsonLine(p, { b: 2 });
  appendJsonLine(p, { c: 3 });
  const content = fs.readFileSync(p, 'utf8');
  assert.strictEqual(content, '{"a":1}\n{"b":2}\n{"c":3}\n');
}

// ===========================================================================
// Redaction integration tests
// ===========================================================================

{
  // setRedactor and getRedactor exist
  assert.strictEqual(typeof setRedactor, 'function', 'setRedactor must be exported');
  assert.strictEqual(typeof getRedactor, 'function', 'getRedactor must be exported');
  assert.strictEqual(getRedactor(), null, 'Initially no redactor');
}

{
  const r = new Redactor();
  r.registerSecret('test_key', 'secret-value-123');
  setRedactor(r);
  assert.ok(getRedactor() !== null, 'Redactor must be set');

  // writeTextFileAtomic redacts content
  const p = tmpFile();
  writeTextFileAtomic(p, 'this contains secret-value-123 inside');
  const content = fs.readFileSync(p, 'utf8');
  assert.strictEqual(content.includes('secret-value-123'), false, 'Secret must be redacted from text file');
  assert.ok(content.includes('\u00abredacted:test_key\u00bb'), 'Placeholder must be present');

  // writeJsonFileAtomic redacts JSON values
  const p2 = tmpFile();
  writeJsonFileAtomic(p2, { api_key: 'secret-value-123', normal: 'keep' });
  const jsonContent = JSON.parse(fs.readFileSync(p2, 'utf8'));
  assert.strictEqual(jsonContent.api_key, '\u00abredacted:api_key\u00bb', 'api_key value must be redacted');
  assert.strictEqual(jsonContent.normal, 'keep', 'Normal field must be preserved');

  // Registered exact values in JSON are also redacted
  const p3 = tmpFile();
  writeJsonFileAtomic(p3, { key: 'secret-value-123' });
  const jsonContent2 = JSON.parse(fs.readFileSync(p3, 'utf8'));
  assert.strictEqual(jsonContent2.key, '\u00abredacted:test_key\u00bb', 'Exact registered value must be redacted');

  // appendJsonLine redacts content
  const p4 = tmpFile();
  appendJsonLine(p4, { password: 'secret-value-123' });
  const line = JSON.parse(fs.readFileSync(p4, 'utf8'));
  assert.strictEqual(line.password, '\u00abredacted:password\u00bb', 'Password value must be redacted');
}

// Reset redactor to avoid affecting other tests
setRedactor(null);
assert.strictEqual(getRedactor(), null, 'Redactor must be resettable');

{
  // Without redactor, writes pass through unchanged
  setRedactor(null);
  const p = tmpFile();
  writeTextFileAtomic(p, 'secret-value-123');
  const content = fs.readFileSync(p, 'utf8');
  assert.strictEqual(content, 'secret-value-123', 'Without redactor, text must pass through');
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
}
