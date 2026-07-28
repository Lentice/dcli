const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeTextFileAtomic, writeJsonFileAtomic, appendJsonLine } = require('../../core/fs-text');

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

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
}
