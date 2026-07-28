const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const SENTINEL = '// @suite full';
const SUITE = parseSuite();

/**
 * @returns {'quick' | 'full'}
 */
function parseSuite() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--suite') {
      if (args[i + 1] === 'full') return 'full';
      return 'quick';
    }
  }
  return 'quick';
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function discoverTests(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...discoverTests(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * @param {string} testPath
 * @returns {string}
 */
function getGroup(testPath) {
  const rel = path.relative(ROOT, testPath);
  return rel.split(path.sep)[0];
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isSlow(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const firstLine = content.split('\n')[0].trim();
  return firstLine === SENTINEL;
}

/**
 * @param {{ passed: boolean, exitCode: number|null, stdout: string, stderr: string, error?: Error }}
 */
function runTest(filePath) {
  const result = spawnSync(process.execPath, [filePath], {
    timeout: 30_000,
    windowsHide: true,
    encoding: 'utf8',
  });
  return {
    passed: result.status === 0 && result.error === undefined,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

/**
 * @returns {string}
 */
function formatSummary() {
  const allFiles = discoverTests(ROOT);
  const groupMap = new Map();

  for (const file of allFiles) {
    const group = getGroup(file);
    if (!groupMap.has(group)) groupMap.set(group, []);
    groupMap.get(group).push(file);
  }

  const groupNames = [...groupMap.keys()].sort();
  if (groupNames.length === 0) {
    return { output: '(no test files found)\n', anyFailed: false };
  }

  const maxLen = Math.max(...groupNames.map(g => `${g}:`.length)) + 1;
  const lines = [];
  let anyFailed = false;

  for (const group of groupNames) {
    const files = groupMap.get(group);
    let passed = 0;
    let failedCount = 0;
    let skipped = 0;
    const skippedFiles = [];

    for (const file of files) {
      if (SUITE === 'quick' && isSlow(file)) {
        skipped++;
        skippedFiles.push(path.relative(ROOT, file));
        continue;
      }
      const res = runTest(file);
      if (res.passed) {
        passed++;
      } else {
        failedCount++;
        anyFailed = true;
      }
    }

    const label = `${group}:`.padEnd(maxLen);
    let line = `${label} ${passed} passed`;
    if (failedCount > 0) line += `, ${failedCount} failed`;
    if (skipped > 0) line += `, ${skipped} skipped`;
    lines.push(line);
    for (const sf of skippedFiles) {
      lines.push(`  (skipped) ${sf}`);
    }
  }

  return { output: lines.join('\n') + '\n', anyFailed };
}

const result = formatSummary();
process.stdout.write(result.output);
process.exit(result.anyFailed ? 1 : 0);
