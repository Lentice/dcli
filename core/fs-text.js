const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENCODING = 'utf8';
const BOM = '\uFEFF';

let atomicRenameSupported = null;
let _redactor = null;

/**
 * @returns {boolean}
 */
function detectAtomicRename() {
  const tmpDir = require('os').tmpdir();
  const rnd = () => crypto.randomBytes(4).toString('hex');
  const src = path.join(tmpDir, `.dcli-atom-${rnd()}`);
  const dst = path.join(tmpDir, `.dcli-atom-${rnd()}`);
  try {
    fs.writeFileSync(src, '');
    fs.writeFileSync(dst, '');
    fs.renameSync(src, dst);
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(dst); } catch {}
    try { fs.unlinkSync(src); } catch {}
  }
}

atomicRenameSupported = detectAtomicRename();

/**
 * @param {string} filePath
 * @returns {string}
 */
function tmpPath(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const rnd = crypto.randomBytes(8).toString('hex');
  return path.join(dir, `${base}.tmp-${rnd}`);
}

function setRedactor(redactor) {
  _redactor = redactor;
}

function getRedactor() {
  return _redactor;
}

/**
 * @param {string} filePath
 * @param {string} content - UTF-8 text
 */
function writeTextFileAtomic(filePath, content) {
  const tmp = tmpPath(filePath);
  const toWrite = _redactor ? _redactor.redactText(content) : content;
  const buf = Buffer.from(toWrite, ENCODING);
  fs.writeFileSync(tmp, buf);
  try {
    const fd = fs.openSync(tmp, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
  }
  fs.renameSync(tmp, filePath);
}

/**
 * @param {string} filePath
 * @param {unknown} value
 */
function writeJsonFileAtomic(filePath, value) {
  const toWrite = _redactor ? _redactor.redactJson(value) : value;
  const json = JSON.stringify(toWrite, stableKeyReplacer, 2) + '\n';
  writeTextFileAtomic(filePath, json);
}

/**
 * @param {string} filePath
 * @param {unknown} value
 */
function appendJsonLine(filePath, value) {
  const toWrite = _redactor ? _redactor.redactJson(value) : value;
  const line = JSON.stringify(toWrite) + '\n';
  fs.appendFileSync(filePath, line, ENCODING);
}

/**
 * @param {string} _key
 * @param {unknown} value
 * @returns {unknown}
 */
function stableKeyReplacer(_key, value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted = {};
    for (const k of Object.keys(value).sort()) {
      sorted[k] = value[k];
    }
    return sorted;
  }
  return value;
}

module.exports = {
  writeTextFileAtomic,
  writeJsonFileAtomic,
  appendJsonLine,
  setRedactor,
  getRedactor,
  __detect: detectAtomicRename,
};
