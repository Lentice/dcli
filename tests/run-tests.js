const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const SENTINEL_FULL = '// @suite full';
const SENTINEL_SERIAL = '// @serial';
const DEFAULT_TIMEOUT = 120_000;
const MAX_OUTPUT = 256 * 1024;
const CLOSE_GUARD_MS = 50;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} [opts.root]  defaults to __dirname
 * @param {number} [opts.concurrency]  defaults to max(1, cpus-2)
 * @param {number} [opts.timeoutMs]  defaults to DEFAULT_TIMEOUT
 * @param {'quick'|'full'} [opts.suite]  defaults to 'quick'
 * @returns {Promise<{output: string, anyFailed: boolean}>}
 */
async function runTests(opts) {
  const root = opts.root || __dirname;
  const suite = opts.suite || 'quick';
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT;
  const concurrency = opts.concurrency != null ? opts.concurrency : Math.max(1, os.cpus().length - 2);

  const allFiles = discoverTests(root);
  const fileMeta = allFiles.map(f => ({
    path: f,
    rel: path.relative(root, f),
    group: getGroup(root, f),
    isFull: hasSentinel(f, SENTINEL_FULL),
    isSerial: hasSentinel(f, SENTINEL_SERIAL),
  }));

  const toRun = suite === 'full' ? fileMeta : fileMeta.filter(f => !f.isFull);
  const sorted = [...toRun].sort((a, b) => a.rel.localeCompare(b.rel));

  const allResults = [];
  let parallelBatch = [];

  for (const f of sorted) {
    if (f.isSerial) {
      if (parallelBatch.length > 0) {
        const batch = await runParallelBatch(parallelBatch, concurrency, timeoutMs);
        allResults.push(...batch);
        parallelBatch = [];
      }
      const r = await runSingle(f, timeoutMs);
      allResults.push(r);
    } else {
      parallelBatch.push(f);
    }
  }
  if (parallelBatch.length > 0) {
    const batch = await runParallelBatch(parallelBatch, concurrency, timeoutMs);
    allResults.push(...batch);
  }

  return formatResults(fileMeta, allResults, suite);
}

module.exports = { runTests };

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = parseArgs();
  if (args.exitCode) {
    process.stderr.write(args.message + '\n');
    process.exit(args.exitCode);
  }
  runTests(args.opts).then(({ output, anyFailed }) => {
    process.stdout.write(output);
    process.exit(anyFailed ? 1 : 0);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * @returns {{ opts: import('./run-tests').RunTestsOpts } | { exitCode: number, message: string }}
 */
function parseArgs() {
  const raw = process.argv.slice(2);
  const opts = {
    root: __dirname,
    concurrency: undefined,
    timeoutMs: undefined,
    suite: 'quick',
  };

  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];

    if (arg === '--suite') {
      i++;
      if (!raw[i] || raw[i].startsWith('--')) {
        return { exitCode: 2, message: 'error: --suite requires a value ("quick" or "full")' };
      }
      if (raw[i] !== 'quick' && raw[i] !== 'full') {
        return { exitCode: 2, message: `error: unknown suite "${raw[i]}"; expected "quick" or "full"` };
      }
      opts.suite = raw[i];
      continue;
    }

    if (arg === '--concurrency') {
      i++;
      if (!raw[i] || raw[i].startsWith('--')) {
        return { exitCode: 2, message: 'error: --concurrency requires an integer value (1-64)' };
      }
      const n = parseInt(raw[i], 10);
      if (!Number.isInteger(n) || n < 1 || n > 64 || String(n) !== raw[i]) {
        return { exitCode: 2, message: `error: --concurrency must be an integer between 1 and 64, got "${raw[i]}"` };
      }
      opts.concurrency = n;
      continue;
    }

    if (arg === '--timeout-ms') {
      i++;
      if (!raw[i] || raw[i].startsWith('--')) {
        return { exitCode: 2, message: 'error: --timeout-ms requires an integer value (1000-600000)' };
      }
      const n = parseInt(raw[i], 10);
      if (!Number.isInteger(n) || n < 1000 || n > 600000 || String(n) !== raw[i]) {
        return { exitCode: 2, message: `error: --timeout-ms must be an integer between 1000 and 600000, got "${raw[i]}"` };
      }
      opts.timeoutMs = n;
      continue;
    }

    if (arg === '--root') {
      i++;
      if (!raw[i] || raw[i].startsWith('--')) {
        return { exitCode: 2, message: 'error: --root requires a path' };
      }
      opts.root = path.resolve(raw[i]);
      continue;
    }

    if (arg.startsWith('--')) {
      return { exitCode: 2, message: `error: unknown flag "${arg}"` };
    }

    // Reject positional arguments (AGENTS.md: reject ignored flags and positionals)
    return { exitCode: 2, message: `error: unexpected positional argument "${arg}"` };
  }

  return { opts };
}

// ---------------------------------------------------------------------------
// Discovery and metadata
// ---------------------------------------------------------------------------

/**
 * @param {string} dir
 * @returns {string[]}
 */
function discoverTests(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === 'fixtures') continue;
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
 * @param {string} root
 * @param {string} testPath
 * @returns {string}
 */
function getGroup(root, testPath) {
  const rel = path.relative(root, testPath);
  return rel.split(path.sep)[0];
}

/**
 * Check if a trimmed line matches or starts-with-space-after the sentinel.
 * @param {string} line
 * @param {string} sentinel
 * @returns {boolean}
 */
function lineMatchesSentinel(line, sentinel) {
  if (!line) return false;
  const t = line.trim();
  return t === sentinel || t.startsWith(sentinel + ' ');
}

/**
 * Check if a file carries a @-sentinel on line 1 or 2.
 * @param {string} filePath
 * @param {string} sentinel
 * @returns {boolean}
 */
function hasSentinel(filePath, sentinel) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  return lineMatchesSentinel(lines[0], sentinel) || lineMatchesSentinel(lines[1], sentinel);
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * @param {{ path: string, rel: string, group: string }[]} files
 * @param {number} concurrency
 * @param {number} timeoutMs
 * @returns {Promise<{ rel: string, passed: boolean, exitCode: number, timedOut: boolean, timeoutMs: number, stdout: string, stderr: string }[]>}
 */
function runParallelBatch(files, concurrency, timeoutMs) {
  return new Promise((resolve) => {
    const results = new Array(files.length);
    let next = 0;
    let active = 0;
    let done = 0;

    function startNext() {
      while (active < concurrency && next < files.length) {
        const i = next++;
        active++;
        runSingle(files[i], timeoutMs).then(r => {
          results[i] = r;
          active--;
          done++;
          if (done === files.length) {
            resolve(results);
          } else {
            startNext();
          }
        });
      }
      if (done === files.length) {
        resolve(results);
      }
    }

    if (files.length === 0) {
      resolve(results);
    } else {
      startNext();
    }
  });
}

/**
 * @param {{ path: string, rel: string }} fileMeta
 * @param {number} timeoutMs
 * @returns {Promise<{ rel: string, passed: boolean, exitCode: number, timedOut: boolean, timeoutMs: number, stdout: string, stderr: string }>}
 */
function runSingle(fileMeta, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileMeta.path], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let exitCode = null;
    let resolved = false;
    let drainTimer = null;

    function finish() {
      if (resolved) return;
      resolved = true;
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      resolve({
        rel: fileMeta.rel,
        passed: !timedOut && exitCode === 0,
        exitCode: exitCode != null ? exitCode : -1,
        timedOut,
        timeoutMs,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
      });
    }

    // On process exit: save code, start bounded drain for 'close'
    // (grandchild may hold pipe open past exit)
    function onExit(code) {
      exitCode = code;
      if (!resolved) {
        clearTimeout(drainTimer);
        drainTimer = setTimeout(finish, CLOSE_GUARD_MS);
      }
    }

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill();
      onExit(-1); // start drain after kill
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    // 'close' fires after streams flush — prefer this over exit
    child.on('close', (code) => {
      exitCode = code;
      finish();
    });

    child.on('exit', onExit);

    child.on('error', () => {
      if (exitCode == null) exitCode = -1;
      finish();
    });
  });
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * @param {{ path: string, rel: string, group: string }[]} active
 * @param {{ rel: string, passed: boolean, exitCode: number, timedOut: boolean, timeoutMs: number, stdout: string, stderr: string }[]} results
 * @param {'quick'|'full'} suite
 * @returns {{ output: string, anyFailed: boolean }}
 */
function formatResults(active, results, suite) {
  const resultMap = new Map();
  for (const r of results) {
    resultMap.set(r.rel, r);
  }

  const groupMap = new Map();
  for (const f of active) {
    if (!groupMap.has(f.group)) groupMap.set(f.group, []);
    groupMap.get(f.group).push(f);
  }

  const groupNames = [...groupMap.keys()].sort();
  if (groupNames.length === 0) {
    return { output: '(no test files found)\n', anyFailed: false };
  }

  const maxLen = Math.max(...groupNames.map(g => `${g}:`.length)) + 1;
  const lines = [];
  const failures = [];
  let anyFailed = false;

  for (const group of groupNames) {
    const files = groupMap.get(group);
    let passed = 0;
    let failedCount = 0;
    let skipped = 0;
    const groupSkipped = [];

    for (const f of files) {
      if (suite === 'quick' && f.isFull) {
        skipped++;
        groupSkipped.push(f.rel);
        continue;
      }
      const r = resultMap.get(f.rel);
      if (!r) {
        failedCount++;
        anyFailed = true;
        failures.push({ rel: f.rel, exitCode: -1, timedOut: false, stdout: '', stderr: 'test did not produce a result' });
      } else if (r.passed) {
        passed++;
      } else {
        failedCount++;
        anyFailed = true;
        failures.push(r);
      }
    }

    const label = `${group}:`.padEnd(maxLen);
    let line = `${label} ${passed} passed`;
    if (failedCount > 0) line += `, ${failedCount} failed`;
    if (skipped > 0) line += `, ${skipped} skipped`;
    lines.push(line);
    for (const sf of groupSkipped) {
      lines.push(`  (skipped) ${sf}`);
    }
  }

  if (failures.length > 0) {
    lines.push('');
    lines.push('--- FAILURES ---');
    for (const f of failures) {
      if (f.timedOut) {
        lines.push(`  ${f.rel}  (timed out after ${f.timeoutMs || DEFAULT_TIMEOUT} ms)`);
      } else {
        lines.push(`  ${f.rel}  (exit code: ${f.exitCode})`);
      }
      lines.push(`    --- stdout ---`);
      for (const l of f.stdout.split('\n')) {
        lines.push(`    ${l}`);
      }
      lines.push(`    --- stderr ---`);
      for (const l of f.stderr.split('\n')) {
        lines.push(`    ${l}`);
      }
    }
  }

  return { output: lines.join('\n') + '\n', anyFailed };
}

// ---------------------------------------------------------------------------
// Output bounding
// ---------------------------------------------------------------------------

/**
 * @param {string} s
 * @returns {string}
 */
function truncateOutput(s) {
  if (s.length <= MAX_OUTPUT) return s;
  const half = Math.floor(MAX_OUTPUT / 2);
  const head = s.slice(0, half);
  const tail = s.slice(-half);
  const note = `\n... [output truncated at ${MAX_OUTPUT} bytes; ${s.length - MAX_OUTPUT} bytes dropped] ...\n`;
  return head + note + tail;
}
