// @suite full
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { JobStore } = require('../../core/job-store');
const { LockManager } = require('../../core/locking');
const { assertRealFailure } = require('../helpers/assert-failure');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-tdc-test-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return fn(dir).then(cleanup, (err) => { cleanup(); throw err; });
}

function makeTerminalJob(store, repoKey, jobId, state, attemptNum) {
  const num = attemptNum || 1;
  const now = new Date();
  store.createJob({
    jobId, repoKey, repoRoot: '/tmp/test',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
    hardTimeoutSec: 3600,
  });
  store.createAttemptDir({ repoKey, jobId, attemptNum: num });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created', attempt: num, from: null, to: 'created',
    detail: { attempt_id: `a${num}`, execution_token: 'tok_' + jobId },
  });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed', attempt: num, from: 'created', to: 'running',
    detail: { started_at: new Date(now - 5000).toISOString(), phase: 'agent_running', worker_pid: process.pid },
  });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed', attempt: num, from: 'running', to: state,
    detail: {
      finished_at: new Date().toISOString(),
      command_exit_code: state === 'done' ? 0 : 1,
      phase: 'terminal',
      ...(state === 'done' ? { result_bytes: 100 } : {}),
    },
  });
  const jobDir = store.getJobDir(repoKey, jobId);
  const attemptDir = path.join(jobDir, 'attempts', String(num));
  fs.mkdirSync(attemptDir, { recursive: true });
  return { jobDir, attemptDir };
}

function writeWorkerLog(attemptDir, lines, finalLine) {
  const logPath = path.join(attemptDir, 'worker.log');
  fs.writeFileSync(logPath, lines.join('\n') + (finalLine !== undefined ? '\n' + finalLine : '\n'), 'utf8');
  return logPath;
}

function writeBackendEvents(attemptDir, events) {
  const ep = path.join(attemptDir, 'backend-events.jsonl');
  fs.writeFileSync(ep, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

async function main() {

// ===========================================================================
// TAIL tests
// ===========================================================================

// 1. tail seeks before reading; large-file test asserts bounded allocation
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const { jobDir, attemptDir } = makeTerminalJob(store, repoKey, 'tail-1', 'done');

  const longLines = [];
  for (let i = 0; i < 500; i++) longLines.push(`worker_line_${i}_${'x'.repeat(40)}`);
  writeWorkerLog(attemptDir, longLines);

  // Also write backend events
  writeBackendEvents(attemptDir, [
    { seq: 1, type: 'session_created' },
    { seq: 2, type: 'message', text: 'x'.repeat(200) },
  ]);

  const { executeTail } = require('../../core/commands/tail');
  const result = await executeTail({ store, repoKey, jobId: 'tail-1', maxBytes: 300 });

  // worker tail should be bounded
  assert.ok(result.worker, 'worker log tail must exist');
  assert.ok(result.worker.truncated, 'tail on large file must be truncated');
  assert.ok(result.worker.returnedBytes <= 300 + 50,
    `returnedBytes ${result.worker.returnedBytes} must be bounded`);
  assert.ok(result.worker.content.includes('(truncated)'), 'truncation marker must be present');

  // backend events tail should also be bounded
  assert.ok(result.backendEvents, 'backend events tail must exist');
  assert.ok(result.backendEvents.returnedBytes <= 300 + 50,
    `backend events returnedBytes ${result.backendEvents.returnedBytes} must be bounded`);

  console.log('PASS: tail test 1 — bounded seek on large files');
});

// 2. Oversized final line is retrievable with a marker
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const { attemptDir } = makeTerminalJob(store, repoKey, 'tail-2', 'done');

  const veryLongLine = 'a'.repeat(10000);
  writeWorkerLog(attemptDir, ['first line', 'second line'], veryLongLine);

  const { executeTail } = require('../../core/commands/tail');
  const result = await executeTail({ store, repoKey, jobId: 'tail-2', maxBytes: 500 });

  assert.ok(result.worker, 'worker log must be readable');
  // The oversized final line content should be retrievable (even if truncated)
  assert.ok(result.worker.content.includes('aaa') || result.worker.truncated,
    'oversized line content must be present or truncation indicated');
  console.log('PASS: tail test 2 — oversized final line retrievable');
});

// 3. tail: job not found → exit 3
{
  const { executeTail } = require('../../core/commands/tail');
  try {
    await executeTail({
      store: {
        getJobDir: () => path.join(os.tmpdir(), 'dcli-no-such-job-dir-' + process.pid),
        regenerateStatus: () => { throw new Error('not found'); },
      },
      repoKey: 'x',
      jobId: 'nonexistent',
    });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.strictEqual(err.exitCode, 3, 'not found must exit 3');
  }
  console.log('PASS: tail test 3 — job not found exits 3');
}

// 4. tail is zero-wait (held per-job lock does not block it)
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const { attemptDir } = makeTerminalJob(store, repoKey, 'tail-4', 'done');
  writeWorkerLog(attemptDir, ['some log content', 'more log']);

  // Hold the per-job lock
  const lockManager = new LockManager({ lockDir: path.join(dir, 'locks') });
  const lock = lockManager.acquire('per-job', 'tail-4', { operation: 'test-hold' });

  try {
    const { executeTail } = require('../../core/commands/tail');
    const result = await executeTail({ store, repoKey, jobId: 'tail-4', maxBytes: 200 });
    assert.ok(result.worker, 'tail must return content even with lock held');
    assert.ok(result.worker.content.includes('some log'), 'tail content must be correct');
  } finally {
    lockManager.release(lock);
  }
  console.log('PASS: tail test 4 — zero-wait with held lock');
});

// ===========================================================================
// DEBUG tests
// ===========================================================================

// 5. debug includes all required fields
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const { attemptDir } = makeTerminalJob(store, repoKey, 'debug-1', 'done');

  // Write stderr for last N lines test
  const stderrLines = [];
  for (let i = 0; i < 20; i++) stderrLines.push(`stderr_line_${i}`);
  fs.writeFileSync(path.join(attemptDir, 'stderr.log'), stderrLines.join('\n') + '\n', 'utf8');

  const { executeDebug } = require('../../core/commands/debug');
  const report = await executeDebug({ store, repoKey, jobId: 'debug-1' });

  // Check all required fields
  assert.ok(report.job_id, 'report must have job_id');
  assert.ok(report.state, 'report must have state');
  assert.ok(report.attempt !== undefined && report.attempt !== null, 'report must have attempt');
  assert.ok(report.phase !== undefined, 'report must have phase');
  assert.ok(report.timings.created_at, 'report must have timings.created_at');
  assert.ok(report.worker !== undefined, 'report must have worker info');
  assert.ok(report.backend !== undefined, 'report must have backend info');
  assert.ok(report.containment !== undefined, 'report must have containment info');
  assert.ok(report.timings !== undefined, 'report must have timings');
  assert.ok(report.result !== undefined, 'report must have result info');
  assert.ok(report.stderr !== undefined, 'report must have stderr lines');
  assert.ok(report.cancel_rungs !== undefined, 'report must have cancel rungs');
  assert.ok(report.result.findings_status !== undefined, 'report must have findings_status');

  console.log('PASS: debug test 1 — includes all required fields');
});

// 6. debug surfaces process-outlives-completion warning
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const { jobDir, attemptDir } = makeTerminalJob(store, repoKey, 'debug-2', 'running');

  // Write a completion sentinel
  fs.writeFileSync(path.join(attemptDir, 'worker-complete.json'), JSON.stringify({ exit_code: 0 }), 'utf8');

  const { executeDebug } = require('../../core/commands/debug');
  const report = await executeDebug({ store, repoKey, jobId: 'debug-2' });

  assert.ok(report.warning && report.warning.includes('process_outlived'),
    `debug must surface process-outlives warning, got: ${report.warning}`);
  console.log('PASS: debug test 2 — process-outlives-completion warning');
});

// 7. debug is zero-wait (held lock does not block it)
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  makeTerminalJob(store, repoKey, 'debug-3', 'done');

  // Hold the per-job lock
  const lockManager = new LockManager({ lockDir: path.join(dir, 'locks') });
  const lock = lockManager.acquire('per-job', 'debug-3', { operation: 'test-hold' });

  try {
    const { executeDebug } = require('../../core/commands/debug');
    const report = await executeDebug({ store, repoKey, jobId: 'debug-3' });
    assert.ok(report.state === 'done' || report.state === 'running',
      'debug must return even with lock held');
  } finally {
    lockManager.release(lock);
  }
  console.log('PASS: debug test 3 — zero-wait with held lock');
});

// ===========================================================================
// CLEANUP tests
// ===========================================================================

// 8. cleanup --dry-run deletes nothing
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  makeTerminalJob(store, repoKey, 'clean-dr-1', 'done');

  const beforeFiles = [];
  function collectFiles(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) collectFiles(full);
      else beforeFiles.push(full);
    }
  }
  collectFiles(dir);
  beforeFiles.sort();

  const { executeCleanup } = require('../../core/commands/cleanup');
  const result = await executeCleanup({ store, dryRun: true });

  // Verify no files were changed
  const afterFiles = [];
  function collectAfter(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) collectAfter(full);
      else afterFiles.push(full);
    }
  }
  collectAfter(dir);
  afterFiles.sort();

  assert.deepStrictEqual(beforeFiles, afterFiles, 'dry-run must not change files');
  assert.ok(result.dryRun, 'result must indicate dry-run');
  console.log('PASS: cleanup test 1 — --dry-run deletes nothing');
});

// 9. Hours are accepted by both argument parsing and cleanup conversion
{
  const { parseArgs } = require('../../core/cli-args');
  const { parseDuration } = require('../../core/commands/cleanup');
  const parsed = parseArgs(['--backend', 'fake', 'cleanup', '--older-than', '12h']);
  assert.strictEqual(parsed.olderThan, '12h', '12h must be accepted by argument parsing');
  assert.strictEqual(parseDuration(parsed.olderThan), 12 * 60 * 60 * 1000,
    '12h must be accepted by cleanup execution');
  console.log('PASS: cleanup test 2 — 12h is accepted end to end');
}

// 10. Invalid --older-than values carry an identifiable validation failure
{
  const { parseArgs } = require('../../core/cli-args');

  try {
    parseArgs(['--backend', 'fake', 'cleanup', '--older-than', 'invalid']);
    assert.fail('Should have thrown for invalid --older-than');
  } catch (err) {
    assertRealFailure(err, { exitCode: 2, match: /Invalid --older-than format/ }, 'non-numeric --older-than');
  }

  try {
    parseArgs(['--backend', 'fake', 'cleanup', '--older-than', '0']);
    assert.fail('Should have thrown for bare 0');
  } catch (err) {
    assertRealFailure(err, { exitCode: 2, match: /Invalid --older-than format/ }, 'unitless --older-than');
  }

  for (const value of ['0d', '0h']) {
    try {
      parseArgs(['--backend', 'fake', 'cleanup', '--older-than', value]);
      assert.fail(`Should have thrown for ${value}`);
    } catch (err) {
      assertRealFailure(err, { exitCode: 2, match: /at least 1/ }, `zero --older-than ${value}`);
    }
  }

  try {
    parseArgs(['--backend', 'fake', 'cleanup', '--older-than']);
    assert.fail('Should have thrown for missing --older-than value');
  } catch (err) {
    assertRealFailure(err, { exitCode: 2, match: /requires a value/ }, 'missing --older-than value');
  }

  try {
    parseArgs(['--backend', 'fake', 'cleanup', '--older-than', '-1d']);
    assert.fail('Should have thrown for negative');
  } catch (err) {
    assertRealFailure(err, { exitCode: 2, match: /Invalid --older-than format/ }, 'negative retention');
  }

  console.log('PASS: cleanup test 3 — invalid --older-than values are rejected');
}

// 11. Only terminal jobs are eligible
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  makeTerminalJob(store, repoKey, 'clean-term-1', 'done', 1);

  // Non-terminal job (stays in 'running')
  const runningJobId = 'clean-term-running';
  store.createJob({
    jobId: runningJobId, repoKey, repoRoot: '/tmp/test',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
    hardTimeoutSec: 999999,
  });
  store.createAttemptDir({ repoKey, jobId: runningJobId, attemptNum: 1 });
  store.journalTransition(runningJobId, repoKey, {
    kind: 'attempt_created', attempt: 1, from: null, to: 'created',
    detail: { attempt_id: 'a1', execution_token: 'tok_running' },
  });
  store.journalTransition(runningJobId, repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'running',
    detail: { started_at: new Date().toISOString(), phase: 'agent_running' },
  });

  const { executeCleanup } = require('../../core/commands/cleanup');
  const result = await executeCleanup({ store });
  assert.strictEqual(result.removed, 1, 'only terminal job should be removed');
  console.log('PASS: cleanup test 5 — only terminal jobs eligible');
});

// 12. Per-job lock: removal takes lock and re-checks
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  makeTerminalJob(store, repoKey, 'clean-lock-1', 'done');

  // Acquire the per-job lock externally so cleanup can't
  const lockManager = new LockManager({ lockDir: path.join(dir, 'locks') });
  const lock = lockManager.acquire('per-job', 'clean-lock-1', { operation: 'test-hold' });

  try {
    const { executeCleanup } = require('../../core/commands/cleanup');
    const result = await executeCleanup({ store });
    assert.strictEqual(result.removed, 0, 'locked job must be skipped');
    assert.strictEqual(result.skipped, 1, 'locked job must be counted as skipped');

    // Job still exists
    const status = store.readStatus({ repoKey, jobId: 'clean-lock-1' });
    assert.ok(status, 'locked job must survive');
  } finally {
    lockManager.release(lock);
  }
  console.log('PASS: cleanup test 5 — per-job lock respected');
});

// 13. Lease-held jobs skipped even when past retention
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  makeTerminalJob(store, repoKey, 'clean-lease-1', 'done');

  // Hold a lease lock
  const lockManager = new LockManager({ lockDir: path.join(dir, 'locks') });
  const lock = lockManager.acquire('job-lease', 'clean-lease-1', { operation: 'test-lease' });

  try {
    const { executeCleanup } = require('../../core/commands/cleanup');
    const result = await executeCleanup({ store });
    assert.strictEqual(result.removed, 0, 'leased job must be skipped');
    assert.strictEqual(result.skipped, 1, 'leased job counted as skipped');

    // Job still exists
    const status = store.readStatus({ repoKey, jobId: 'clean-lease-1' });
    assert.ok(status, 'leased job must survive');
  } finally {
    lockManager.release(lock);
  }
  console.log('PASS: cleanup test 6 — lease-held jobs skipped');
});

// 14. Counters increment only after successful removal
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  // Two terminal jobs
  makeTerminalJob(store, repoKey, 'clean-cnt-1', 'done');
  makeTerminalJob(store, repoKey, 'clean-cnt-2', 'done');

  // Lock the second job so it fails
  const lockManager = new LockManager({ lockDir: path.join(dir, 'locks') });
  const lock = lockManager.acquire('per-job', 'clean-cnt-2', { operation: 'test-hold' });

  try {
    const { executeCleanup } = require('../../core/commands/cleanup');
    const result = await executeCleanup({ store });
    // Only first job should have been removed
    assert.strictEqual(result.removed, 1, 'only the unlockable job should be removed');
    assert.strictEqual(result.skipped, 1, 'the locked job should be skipped');
  } finally {
    lockManager.release(lock);
  }
  console.log('PASS: cleanup test 7 — counter after success only');
});

// 15. --scrub-session-ids blanks backend_session_id
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  makeTerminalJob(store, repoKey, 'clean-scrub-1', 'done');

  // Manually set backend_session_id in the status.json — and in the journal,
  // so the record survives regeneration (a stale-projection judgement can
  // regenerate before the scrub reads, and the id must be visible either way).
  const jobDir = store.getJobDir(repoKey, 'clean-scrub-1');
  const statusPath = path.join(jobDir, 'status.json');
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  status.backend_session_id = 'ses_should_be_scrubbed';
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + '\n', 'utf8');
  store.journalTransition('clean-scrub-1', repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'done', to: 'done',
    detail: { backend_session_id: 'ses_should_be_scrubbed' },
  });

  // Verify session_id exists
  const before = store.readStatus({ repoKey, jobId: 'clean-scrub-1' });
  assert.strictEqual(before.backend_session_id, 'ses_should_be_scrubbed', 'session_id must exist before scrub');

  const { executeCleanup } = require('../../core/commands/cleanup');
  const realRename = fs.renameSync;
  let injectedFailure = false;
  fs.renameSync = (source, destination) => {
    if (!injectedFailure && destination === statusPath) {
      injectedFailure = true;
      const err = new Error('injected transient projection rename failure');
      err.code = 'EPERM';
      throw err;
    }
    return realRename(source, destination);
  };
  let result;
  try {
    result = await executeCleanup({ store, scrubSessionIds: true });
  } finally {
    fs.renameSync = realRename;
  }

  const after = store.readStatus({ repoKey, jobId: 'clean-scrub-1' });
  assert.ok(injectedFailure, 'test must exercise the transient rename fault');
  assert.deepStrictEqual(result.errors, [], 'scrub must not silently swallow projection write failures');
  assert.strictEqual(result.scrubbed, 1, 'scrub must report the projection it persisted');
  assert.strictEqual(after.backend_session_id, null, 'session_id must be null after scrub');
  console.log('PASS: cleanup test 8 — --scrub-session-ids blanks session ids');
});

// 16. scrub is journaled: the null survives regeneration from the journal
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  makeTerminalJob(store, repoKey, 'clean-scrub-2', 'done');

  // Journal the session id the way a real backend does: a started fact.
  store.journalTransition('clean-scrub-2', repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'done', to: 'done',
    detail: { backend_session_id: 'ses_in_journal' },
  });

  const jobDir = store.getJobDir(repoKey, 'clean-scrub-2');
  const journalPath = path.join(jobDir, 'journal.jsonl');
  const beforeLines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
  assert.ok(beforeLines.some(l => l.includes('ses_in_journal')), 'journal must contain the session id before scrub');
  assert.strictEqual(
    store.readStatus({ repoKey, jobId: 'clean-scrub-2' }).backend_session_id,
    'ses_in_journal', 'projection must show the id before scrub'
  );

  const { executeCleanup } = require('../../core/commands/cleanup');
  const result = await executeCleanup({ store, scrubSessionIds: true });
  assert.deepStrictEqual(result.errors, [], 'scrub must not report errors');
  assert.strictEqual(result.scrubbed, 1, 'scrub must count the scrubbed job');

  const afterLines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(afterLines.length, beforeLines.length + 1, 'exactly one journal entry appended');
  assert.deepStrictEqual(afterLines.slice(0, beforeLines.length), beforeLines, 'existing journal entries unchanged');
  const scrubbedEntry = JSON.parse(afterLines[afterLines.length - 1]);
  assert.strictEqual(scrubbedEntry.kind, 'attempt_state_changed', 'scrub must be journaled as attempt_state_changed');
  assert.strictEqual(scrubbedEntry.detail.backend_session_id, null, 'scrubbed detail must null the id');
  assert.ok(scrubbedEntry.detail.session_scrubbed_at, 'scrubbed detail must carry session_scrubbed_at');

  assert.strictEqual(
    store.readStatus({ repoKey, jobId: 'clean-scrub-2' }).backend_session_id,
    null, 'projection must be null after scrub'
  );
  const regenerated = store.regenerateStatus({ repoKey, jobId: 'clean-scrub-2' });
  assert.strictEqual(regenerated.backend_session_id, null, 'regenerated status must keep the scrub');
  console.log('PASS: cleanup test 9 — scrub is journaled and survives regeneration');
});

// 17. A non-terminal job is never scrubbed; its journal is untouched
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  const runningJobId = 'clean-scrub-running';
  store.createJob({
    jobId: runningJobId, repoKey, repoRoot: '/tmp/test',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
    hardTimeoutSec: 999999,
  });
  store.createAttemptDir({ repoKey, jobId: runningJobId, attemptNum: 1 });
  store.journalTransition(runningJobId, repoKey, {
    kind: 'attempt_created', attempt: 1, from: null, to: 'created',
    detail: { attempt_id: 'a1', execution_token: 'tok_running' },
  });
  store.journalTransition(runningJobId, repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'running',
    detail: { started_at: new Date().toISOString(), phase: 'agent_running', backend_session_id: 'ses_running' },
  });

  const jobDir = store.getJobDir(repoKey, runningJobId);
  const journalPath = path.join(jobDir, 'journal.jsonl');
  const before = fs.readFileSync(journalPath, 'utf8');

  const { executeCleanup } = require('../../core/commands/cleanup');
  const result = await executeCleanup({ store, scrubSessionIds: true });
  assert.strictEqual(result.scrubbed, 0, 'non-terminal job must not be scrubbed');
  assert.strictEqual(fs.readFileSync(journalPath, 'utf8'), before, 'non-terminal journal must be untouched');
  assert.strictEqual(
    store.readStatus({ repoKey, jobId: runningJobId }).backend_session_id,
    'ses_running', 'non-terminal session id must survive'
  );
  console.log('PASS: cleanup test 10 — non-terminal jobs never scrubbed');
});

// 18. --dry-run --scrub-session-ids appends no journal event
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const repoKey = 'test-repo';
  makeTerminalJob(store, repoKey, 'clean-scrub-dr', 'done');
  store.journalTransition('clean-scrub-dr', repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'done', to: 'done',
    detail: { backend_session_id: 'ses_dry_run' },
  });

  const jobDir = store.getJobDir(repoKey, 'clean-scrub-dr');
  const journalPath = path.join(jobDir, 'journal.jsonl');
  const before = fs.readFileSync(journalPath, 'utf8');

  const { executeCleanup } = require('../../core/commands/cleanup');
  const result = await executeCleanup({ store, scrubSessionIds: true, dryRun: true });
  assert.strictEqual(result.scrubbed, 0, 'dry-run must not report a scrub');
  assert.strictEqual(fs.readFileSync(journalPath, 'utf8'), before, 'dry-run must not append a journal event');
  console.log('PASS: cleanup test 11 — dry-run appends no journal event');
});

// ===========================================================================
// Summary
// ===========================================================================
console.log('\nAll tail/debug/cleanup tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
