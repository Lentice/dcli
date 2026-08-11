/**
 * Fixture: a version-printing shim for the adapters' DetectVersion probe.
 *
 * DetectVersion runs the backend executable with `--version` through execSync.
 * A test that needs the real probe (not the fake adapter) points CODEX_PATH /
 * CLAUDE_PATH at a .cmd that prints a version and exits — the probe then runs
 * for real against the fixture, exactly as it runs against a backend.
 */
const fs = require('node:fs');
const path = require('node:path');

function writeVersionShim(dir, version) {
  const p = path.join(dir, 'version-shim.cmd');
  fs.writeFileSync(p, ['@echo off', `echo ${version}`, ''].join('\r\n'), 'utf8');
  return p;
}

/**
 * Write a version-printing shim to an explicit path. Used to place the shim
 * under a directory/file name full of spaces and quoting metacharacters, so
 * the probe's argument-array construction is exercised for real.
 *
 * @param {string} filePath
 * @param {string} version
 * @returns {string}
 */
function writeVersionShimAt(filePath, version) {
  fs.writeFileSync(filePath, ['@echo off', `echo ${version}`, ''].join('\r\n'), 'utf8');
  return filePath;
}

/**
 * Run `fn` with the given environment variable pointing at the fixture.
 * The variable is restored (or deleted) in all paths.
 *
 * @param {string} envName
 * @param {string} fixturePath
 * @param {() => Promise<unknown> | unknown} fn
 * @returns {Promise<unknown>}
 */
async function withVersionShim(envName, fixturePath, fn) {
  const saved = process.env[envName];
  process.env[envName] = fixturePath;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[envName];
    else process.env[envName] = saved;
  }
}

module.exports = { writeVersionShim, writeVersionShimAt, withVersionShim };
