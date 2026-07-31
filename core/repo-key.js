const crypto = require('crypto');
const path = require('path');

function normalizePath(inputPath) {
  const resolved = path.resolve(inputPath);
  const normalized = path.normalize(resolved);
  if (process.platform === 'win32') {
    return normalized.toLowerCase().replace(/\\/g, '/');
  }
  return normalized;
}

function computeRepoKey(repoPath) {
  const normalized = normalizePath(repoPath);
  const hash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  return hash.substring(0, 12);
}

function computeRepoKeyWithPath(repoPath) {
  const normalized = normalizePath(repoPath);
  const repoKey = computeRepoKey(repoPath);
  return { repoKey, fullPath: normalized };
}

module.exports = { computeRepoKey, computeRepoKeyWithPath, normalizePath };
