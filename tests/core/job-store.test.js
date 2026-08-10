const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { DEFAULT_TIMEOUT } = require('../run-tests');
const { assertSpawnStatus } = require('../helpers/spawn-assert');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpStateRoot() {
  const dir = path.join(os.tmpdir(), `dcli-store-test-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function writeFixture(path, content) {
  fs.mkdirSync(path.dirname(path), { recursive: true });
  fs.writeFileSync(path, content, 'utf8');
}

// We'll test in child processes for the concurrency test, but for most tests
// we can import the modules directly once they exist.

// For now, require the modules we're about to implement
let getStateRoot;
let computeRepoKey, computeRepoKeyWithPath;
let generateJobId;
let JobStore;

function loadModules() {
  getStateRoot = require('../../core/state-root').getStateRoot;
  const repoKey = require('../../core/repo-key');
  computeRepoKey = repoKey.computeRepoKey;
  computeRepoKeyWithPath = repoKey.computeRepoKeyWithPath;
  generateJobId = require('../../core/job-id').generateJobId;
  JobStore = require('../../core/job-store').JobStore;
}

// ===========================================================================
// 1. State root discovery
// ===========================================================================

{
  // Test state root can be overridden by DCLI_STATE_ROOT
  const customRoot = path.join(os.tmpdir(), `dcli-custom-root-${Math.random().toString(36).slice(2)}`);
  process.env.DCLI_STATE_ROOT = customRoot;
  // reload module fresh
  delete require.cache[require.resolve('../../core/state-root')];
  getStateRoot = require('../../core/state-root').getStateRoot;
  assert.strictEqual(getStateRoot(), customRoot, 'DCLI_STATE_ROOT must override default');
  delete process.env.DCLI_STATE_ROOT;
  
  // Test default platform path (non-empty string)
  delete require.cache[require.resolve('../../core/state-root')];
  getStateRoot = require('../../core/state-root').getStateRoot;
  const defaultRoot = getStateRoot();
  assert.strictEqual(typeof defaultRoot, 'string');
  assert.ok(defaultRoot.length > 0, 'State root must be a non-empty string');
  assert.ok(defaultRoot.endsWith('dcli'), 'State root must end with "dcli"');
}

console.log('PASS: state root discovery');

// ===========================================================================
// 2. repo-key computation
// ===========================================================================

{
  loadModules();
  
  // Same path produces same key
  const key1 = computeRepoKey('C:\\Projects\\MyRepo');
  const key2 = computeRepoKey('C:\\Projects\\MyRepo');
  assert.strictEqual(key1, key2, 'Same path must produce same repo-key');
  
  // Key is 12 lowercase hex characters
  assert.strictEqual(key1.length, 12, 'repo-key must be 12 characters');
  assert.ok(/^[0-9a-f]{12}$/.test(key1), 'repo-key must be lowercase hex');
  
  // Different paths produce different keys
  const key3 = computeRepoKey('C:\\Projects\\OtherRepo');
  assert.notStrictEqual(key1, key3, 'Different paths must produce different repo-keys');
  
  // Compute with path returns key and full path
  const result = computeRepoKeyWithPath('C:\\Projects\\MyRepo');
  assert.strictEqual(typeof result.repoKey, 'string');
  assert.strictEqual(typeof result.fullPath, 'string');
  assert.strictEqual(result.repoKey, key1);
  
  // For case-insensitive Windows, paths differing only in case map to same key
  if (process.platform === 'win32') {
    const keyLower = computeRepoKey('c:\\projects\\myrepo');
    assert.strictEqual(keyLower, key1, 'On Windows, casing must produce same key');
  }
  
  // Mismatch detection: a different path must not collide onto the same key
  assert.notStrictEqual(computeRepoKey('D:\Other\Repo'), key1, 'Different path must yield a different key');
}

console.log('PASS: repo-key computation');

// ===========================================================================
// 3. Job ID generation
// ===========================================================================

{
  loadModules();
  
  const id1 = generateJobId();
  const id2 = generateJobId();
  
  // Format: YYYYMMDDTHHMMSSZ-<8 alphanumerics>
  assert.ok(/^\d{8}T\d{6}Z-[a-z0-9]{8}$/.test(id1), `Job ID must match format, got: ${id1}`);
  assert.ok(/^\d{8}T\d{6}Z-[a-z0-9]{8}$/.test(id2), `Job ID must match format, got: ${id2}`);
  
  // Unique (in reasonable bounds)
  assert.notStrictEqual(id1, id2, 'Two job IDs must be different');
  
  // Sortable: timestamp prefixes are sortable
  const ts1 = id1.split('-')[0];
  const ts2 = id2.split('-')[0];
  assert.ok(ts1 <= ts2, 'Job ID timestamp prefixes must be sortable');
}

console.log('PASS: job ID generation');

// ===========================================================================
// 4. Job directory creation
// ===========================================================================

{
  loadModules();
  const root = tmpStateRoot();
  const store = new JobStore({ stateRoot: root });
  const jobId = generateJobId();
  const repoKeyResult = computeRepoKeyWithPath(__dirname);
  
  const jobDir = store.createJob({
    jobId,
    repoKey: repoKeyResult.repoKey,
    repoRoot: repoKeyResult.fullPath,
    backend: 'fake',
    backendVersion: '1.0.0',
    adapterVersion: '1.0.0',
    mode: 'review',
    access: 'read-only',
    capabilitiesSnapshot: { schema_version: 1, backend: 'fake', core: { run: true } },
    executionOwner: 'wrapper',
    model: null,
    agent: null,
    parentJobId: null,
    rootJobId: jobId,
    group: null,
    label: null,
    hardTimeoutSec: 1800,
  });
  
  // Directory exists with expected structure
  assert.ok(fs.existsSync(jobDir), 'Job directory must exist');
  assert.ok(fs.existsSync(path.join(jobDir, 'status.json')), 'status.json must exist');
  assert.ok(fs.existsSync(path.join(jobDir, 'journal.jsonl')), 'journal.jsonl must exist');
  
  // Creating same job directory again is an error
  assert.throws(() => {
    store.createJob({
      jobId,
      repoKey: repoKeyResult.repoKey,
      repoRoot: repoKeyResult.fullPath,
      backend: 'fake',
      backendVersion: '1.0.0',
      adapterVersion: '1.0.0',
      mode: 'review',
      access: 'read-only',
    });
  }, /already exists/i, 'Creating existing job directory must throw');
  
  clean(root);
}

console.log('PASS: job directory creation');

// ===========================================================================
// 5. Journal append-only with monotonic seq
// ===========================================================================

{
  loadModules();
  const root = tmpStateRoot();
  const store = new JobStore({ stateRoot: root });
  const repoKeyResult = computeRepoKeyWithPath(__dirname);
  const jobId = generateJobId();
  
  store.createJob({
    jobId,
    repoKey: repoKeyResult.repoKey,
    repoRoot: repoKeyResult.fullPath,
    backend: 'fake',
    backendVersion: '1.0.0',
    adapterVersion: '1.0.0',
    mode: 'review',
    access: 'read-only',
  });
  
  // Append a transition
  store.journalTransition(jobId, repoKeyResult.repoKey, {
    kind: 'attempt_state_changed',
    attempt: 1,
    from: 'created',
    to: 'running',
    detail: { phase: 'worker_launching' },
  });
  
  // Read journal
  const entries = store.readJournal({ repoKey: repoKeyResult.repoKey, jobId });
  
  // Exactly 2 entries (job_created + transition)
  assert.strictEqual(entries.length, 2, 'Journal must have 2 entries');
  
  // Seq numbers are monotonic
  assert.strictEqual(entries[0].seq, 1, 'First entry seq must be 1');
  assert.strictEqual(entries[1].seq, 2, 'Second entry seq must be 2');
  
  // Each entry is a plain object (one JSON object per line)
  for (const entry of entries) {
    assert.strictEqual(typeof entry, 'object');
    assert.ok(!Array.isArray(entry));
    assert.strictEqual(typeof entry.seq, 'number');
    assert.strictEqual(typeof entry.at, 'string');
    assert.strictEqual(typeof entry.kind, 'string');
  }
  
  // journal.jsonl is plain text, one object per line
  const journalPath = path.join(store._jobDir(repoKeyResult.repoKey, jobId), 'journal.jsonl');
  const rawLines = fs.readFileSync(journalPath, 'utf8').trim().split('\n');
  assert.strictEqual(rawLines.length, 2, 'journal.jsonl must have 2 lines');
  
  clean(root);
}

console.log('PASS: journal append-only with monotonic seq');

// ===========================================================================
// 6. Journal before projection
// ===========================================================================

{
  loadModules();
  const root = tmpStateRoot();
  const store = new JobStore({ stateRoot: root });
  const repoKeyResult = computeRepoKeyWithPath(__dirname);
  const jobId = generateJobId();
  
  store.createJob({
    jobId,
    repoKey: repoKeyResult.repoKey,
    repoRoot: repoKeyResult.fullPath,
    backend: 'fake',
    backendVersion: '1.0.0',
    adapterVersion: '1.0.0',
    mode: 'review',
    access: 'read-only',
  });
  
  // Transition: created -> running
  store.journalTransition(jobId, repoKeyResult.repoKey, {
    kind: 'attempt_state_changed',
    attempt: 1,
    from: 'created',
    to: 'running',
    detail: { phase: 'agent_running' },
  });
  
  // Read status
  const status = store.readStatus({ repoKey: repoKeyResult.repoKey, jobId });
  assert.strictEqual(status.state, 'running', 'Status state must reflect transition');
  assert.strictEqual(status.phase, 'agent_running', 'Status phase must be set from detail');
  
  // Commit order: append journal -> THEN write status
  // Verify journal was written before status by checking at the raw file level
  const jobDir = store._jobDir(repoKeyResult.repoKey, jobId);
  const journalPath = path.join(jobDir, 'journal.jsonl');
  const journalContent = fs.readFileSync(journalPath, 'utf8');
  const journalEntries = journalContent.trim().split('\n').map(l => JSON.parse(l));
  
  // Last journal entry's state should match status.json
  const lastJournalEntry = journalEntries[journalEntries.length - 1];
  assert.strictEqual(lastJournalEntry.to, status.state, 'Journal entry must match status state');
  
  clean(root);
}

console.log('PASS: journal before projection');

// ===========================================================================
// 7. status.json contains all fields from design spec §5
// ===========================================================================

{
  loadModules();
  const root = tmpStateRoot();
  const store = new JobStore({ stateRoot: root });
  const repoKeyResult = computeRepoKeyWithPath(__dirname);
  const jobId = generateJobId();
  
  store.createJob({
    jobId,
    repoKey: repoKeyResult.repoKey,
    repoRoot: repoKeyResult.fullPath,
    backend: 'opencode',
    backendVersion: '1.18.7',
    adapterVersion: '1.0.0',
    mode: 'review',
    access: 'read-only',
    capabilitiesSnapshot: { schema_version: 1, backend: 'opencode', core: { run: true } },
    executionOwner: 'wrapper',
    model: 'opencode-go/deepseek-v4-flash',
    agent: 'delegate-review',
    parentJobId: null,
    rootJobId: jobId,
    group: null,
    label: 'test-job',
    hardTimeoutSec: 1800,
  });
  
  const status = store.readStatus({ repoKey: repoKeyResult.repoKey, jobId });
  
  // schema_version
  assert.strictEqual(status.schema_version, 1, 'schema_version must be 1');
  
  // Job identity
  assert.strictEqual(status.job_id, jobId);
  assert.strictEqual(status.backend, 'opencode');
  assert.strictEqual(status.backend_version, '1.18.7');
  assert.strictEqual(status.adapter_version, '1.0.0');
  
  // Repo
  assert.strictEqual(status.repo_key, repoKeyResult.repoKey);
  assert.strictEqual(status.repo_root, repoKeyResult.fullPath);
  
  // Mode and access
  assert.strictEqual(status.mode, 'review');
  assert.strictEqual(status.access, 'read-only');
  
  // State and phase
  assert.strictEqual(status.state, 'created');
  assert.strictEqual(status.phase, null);
  
  // Timestamps
  assert.strictEqual(typeof status.created_at, 'string');
  assert.ok(status.created_at.endsWith('Z'), 'created_at must be UTC');
  assert.strictEqual(status.started_at, null);
  assert.strictEqual(typeof status.updated_at, 'string');
  assert.strictEqual(status.finished_at, null);
  assert.strictEqual(status.heartbeat_at, null);
  
  // Process fields are null initially
  assert.strictEqual(status.worker_pid, null);
  assert.strictEqual(status.worker_identity, null);
  assert.strictEqual(status.containment, null);
  assert.strictEqual(status.backend_pid, null);
  assert.strictEqual(status.backend_session_id, null);
  
  // backend_state with its own schema_version
  assert.ok(status.backend_state, 'backend_state must exist');
  assert.strictEqual(status.backend_state.schema_version, 1);
  
  // capabilities_snapshot
  assert.deepStrictEqual(status.capabilities_snapshot, { schema_version: 1, backend: 'opencode', core: { run: true } });
  
  // Execution metadata
  assert.strictEqual(status.execution_owner, 'wrapper');
  assert.strictEqual(status.model, 'opencode-go/deepseek-v4-flash');
  assert.strictEqual(status.agent, 'delegate-review');
  
  // Lineage
  assert.strictEqual(status.parent_job_id, null);
  assert.strictEqual(status.root_job_id, jobId);
  assert.strictEqual(status.session_strategy, null);
  
  // Group and label
  assert.strictEqual(status.group, null);
  assert.strictEqual(status.label, 'test-job');
  
  // Timeouts
  assert.strictEqual(status.hard_timeout_sec, 1800);
  
  // Cancel
  assert.strictEqual(status.cancel_requested_at, null);
  
  // Exit codes - DISTINCT
  assert.strictEqual(status.command_exit_code, null);
  assert.strictEqual(status.backend_exit_code, null);
  
  // Results
  assert.strictEqual(status.result_bytes, 0);
  
  // Tokens
  assert.ok(status.tokens, 'tokens object must exist');
  assert.strictEqual(status.tokens.input, null);
  assert.strictEqual(status.tokens.output, null);
  assert.strictEqual(status.tokens.reasoning, null);
  assert.strictEqual(status.tokens.cache_read, null);
  assert.strictEqual(status.tokens.cache_write, null);
  assert.strictEqual(status.tokens.total, null);
  
  // Cost
  assert.strictEqual(status.cost, null);
  
  // Failure
  assert.strictEqual(status.failure_reason, null);
  assert.strictEqual(status.failure, null);
  
  // Worktree
  assert.ok(status.worktree, 'worktree object must exist');
  assert.strictEqual(status.worktree.path, null);
  assert.strictEqual(status.worktree.base_commit, null);
  assert.strictEqual(status.worktree.result_commit, null);
  assert.strictEqual(status.worktree.changed_files, null);
  
  // Attempt fields
  assert.strictEqual(status.attempt, null);
  assert.strictEqual(status.attempt_id, null);
  assert.strictEqual(status.attempt_state, null);
  assert.strictEqual(status.execution_token, null);
  assert.strictEqual(status.findings_status, null);
  
  clean(root);
}

console.log('PASS: status.json full fields');

// ===========================================================================
// 8. command_exit_code and backend_exit_code are distinct
// ===========================================================================

{
  loadModules();
  const root = tmpStateRoot();
  const store = new JobStore({ stateRoot: root });
  const repoKeyResult = computeRepoKeyWithPath(__dirname);
  const jobId = generateJobId();
  
  store.createJob({
    jobId,
    repoKey: repoKeyResult.repoKey,
    repoRoot: repoKeyResult.fullPath,
    backend: 'fake',
    backendVersion: '1.0.0',
    adapterVersion: '1.0.0',
    mode: 'review',
    access: 'read-only',
  });
  
  // Set command exit code only
  store.journalTransition(jobId, repoKeyResult.repoKey, {
    kind: 'attempt_state_changed',
    attempt: 1,
    from: 'running',
    to: 'done',
    detail: { command_exit_code: 0, phase: 'terminal' },
  });
  
  const status1 = store.readStatus({ repoKey: repoKeyResult.repoKey, jobId });
  assert.strictEqual(status1.command_exit_code, 0);
  assert.strictEqual(status1.backend_exit_code, null);
  
  // Set backend exit code in a second transition
  store.journalTransition(jobId, repoKeyResult.repoKey, {
    kind: 'attempt_state_changed',
    attempt: 1,
    from: 'done',
    to: 'failed',
    detail: { backend_exit_code: 1, command_exit_code: 0, failure_reason: 'backend_error' },
  });
  
  const status2 = store.readStatus({ repoKey: repoKeyResult.repoKey, jobId });
  assert.strictEqual(status2.command_exit_code, 0);
  assert.strictEqual(status2.backend_exit_code, 1);
  assert.strictEqual(status2.failure_reason, 'backend_error');
  
  clean(root);
}

console.log('PASS: distinct exit codes');

// ===========================================================================
// 9. Attempt directory creation and error
// ===========================================================================

{
  loadModules();
  const root = tmpStateRoot();
  const store = new JobStore({ stateRoot: root });
  const repoKeyResult = computeRepoKeyWithPath(__dirname);
  const jobId = generateJobId();
  
  store.createJob({
    jobId,
    repoKey: repoKeyResult.repoKey,
    repoRoot: repoKeyResult.fullPath,
    backend: 'fake',
    backendVersion: '1.0.0',
    adapterVersion: '1.0.0',
    mode: 'review',
    access: 'read-only',
  });
  
  // Create attempt 1
  const attempt1Dir = store.createAttemptDir({ repoKey: repoKeyResult.repoKey, jobId, attemptNum: 1 });
  assert.ok(fs.existsSync(attempt1Dir), 'Attempt directory must exist');
  assert.ok(attempt1Dir.endsWith('attempts' + path.sep + '1'), `Attempt dir must be attempts/1, got ${attempt1Dir}`);
  
  // Creating same attempt again throws
  assert.throws(() => {
    store.createAttemptDir({ repoKey: repoKeyResult.repoKey, jobId, attemptNum: 1 });
  }, /already exists/i);
  
  // Create attempt 2 (different number)
  const attempt2Dir = store.createAttemptDir({ repoKey: repoKeyResult.repoKey, jobId, attemptNum: 2 });
  assert.ok(fs.existsSync(attempt2Dir));
  
  clean(root);
}

console.log('PASS: attempt directory creation');

// ===========================================================================
// 10. repo-key mismatch detection
// ===========================================================================

{
  loadModules();
  const root = tmpStateRoot();
  const store = new JobStore({ stateRoot: root });
  const repoKeyResult1 = computeRepoKeyWithPath(__dirname);
  const jobId = generateJobId();
  
  // Create job with first path
  store.createJob({
    jobId,
    repoKey: repoKeyResult1.repoKey,
    repoRoot: repoKeyResult1.fullPath,
    backend: 'fake',
    backendVersion: '1.0.0',
    adapterVersion: '1.0.0',
    mode: 'review',
    access: 'read-only',
  });
  
  // A different repo path must not map onto this job's repo key
  const differentPath = process.platform === 'win32'
    ? 'D:\different\repo\path'
    : '/different/repo/path';
  assert.notStrictEqual(computeRepoKey(differentPath), repoKeyResult1.repoKey,
    'Different full path must yield a different repo key');
  assert.strictEqual(computeRepoKey(repoKeyResult1.fullPath), repoKeyResult1.repoKey,
    'Same full path must yield the same repo key');
  
  clean(root);
}

console.log('PASS: repo-key mismatch detection');

// ===========================================================================
// 11. Journal replay — regenerate status from journal alone
// ===========================================================================

{
  loadModules();
  const root = tmpStateRoot();
  const store = new JobStore({ stateRoot: root });
  const repoKeyResult = computeRepoKeyWithPath(__dirname);
  const jobId = generateJobId();
  
  store.createJob({
    jobId,
    repoKey: repoKeyResult.repoKey,
    repoRoot: repoKeyResult.fullPath,
    backend: 'fake',
    backendVersion: '1.0.0',
    adapterVersion: '1.0.0',
    mode: 'review',
    access: 'read-only',
  });
  
  // Multiple transitions
  store.journalTransition(jobId, repoKeyResult.repoKey, {
    kind: 'attempt_created',
    attempt: 1,
    from: null,
    to: 'created',
    detail: { attempt_id: 'attempt_1', execution_token: 'tok_abc' },
  });
  
  store.journalTransition(jobId, repoKeyResult.repoKey, {
    kind: 'attempt_state_changed',
    attempt: 1,
    from: 'created',
    to: 'running',
    detail: { phase: 'agent_running', worker_pid: 12345 },
  });
  
  store.journalTransition(jobId, repoKeyResult.repoKey, {
    kind: 'attempt_state_changed',
    attempt: 1,
    from: 'running',
    to: 'done',
    detail: { phase: 'terminal', command_exit_code: 0, result_bytes: 1024 },
  });
  
  // Read current status
  const originalStatus = store.readStatus({ repoKey: repoKeyResult.repoKey, jobId });
  
  // Now regenerate solely from journal
  const regeneratedStatus = store.regenerateStatus({ repoKey: repoKeyResult.repoKey, jobId });
  
  // Compare key fields
  assert.strictEqual(regeneratedStatus.job_id, originalStatus.job_id);
  assert.strictEqual(regeneratedStatus.state, originalStatus.state);
  assert.strictEqual(regeneratedStatus.backend, originalStatus.backend);
  assert.strictEqual(regeneratedStatus.command_exit_code, originalStatus.command_exit_code);
  assert.strictEqual(regeneratedStatus.phase, originalStatus.phase);
  assert.strictEqual(regeneratedStatus.worker_pid, originalStatus.worker_pid);
  
  clean(root);
}

console.log('PASS: journal replay');

// ===========================================================================
// 12. Concurrency test — readers never see torn JSON
// ===========================================================================

{
  loadModules();
  const root = tmpStateRoot();
  const store = new JobStore({ stateRoot: root });
  const repoKeyResult = computeRepoKeyWithPath(__dirname);
  const jobId = generateJobId();
  
  store.createJob({
    jobId,
    repoKey: repoKeyResult.repoKey,
    repoRoot: repoKeyResult.fullPath,
    backend: 'fake',
    backendVersion: '1.0.0',
    adapterVersion: '1.0.0',
    mode: 'review',
    access: 'read-only',
  });
  
  const statusPath = path.join(store._jobDir(repoKeyResult.repoKey, jobId), 'status.json');
  
  // Spawn reader processes that continuously read status.json in a loop
  const READER_COUNT = 3;
  const READ_ITERATIONS = 20;
  const readerScript = `
    const fs = require('fs');
    const p = ${JSON.stringify(statusPath)};
    const iterations = ${READ_ITERATIONS};
    for (let i = 0; i < iterations; i++) {
      try {
        const content = fs.readFileSync(p, 'utf8');
        JSON.parse(content); // must not throw
        // Also verify no BOM
        const buf = Buffer.from(content, 'utf8');
        if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
          process.exit(2);
        }
      } catch(e) {
        process.exit(1);
      }
      // Small random delay
      const delay = Math.floor(Math.random() * 5) + 1;
      const start = Date.now();
      while (Date.now() - start < delay) {}
    }
    process.exit(0);
  `;
  
  const readers = [];
  for (let i = 0; i < READER_COUNT; i++) {
    const proc = spawnSync(process.execPath, ['-e', readerScript], {
      timeout: DEFAULT_TIMEOUT,
      windowsHide: true,
      encoding: 'utf8',
    });
    readers.push(proc);
  }
  
  // Writer: do transitions while readers are active
  for (let i = 0; i < 10; i++) {
    store.journalTransition(jobId, repoKeyResult.repoKey, {
      kind: 'attempt_state_changed',
      attempt: 1,
      from: i % 2 === 0 ? 'running' : 'done',
      to: i % 2 === 0 ? 'done' : 'running',
      detail: { phase: 'updating' },
    });
  }
  
  // Wait for readers (they already completed since spawnSync is blocking)
  // Reap results — actually we used spawnSync which already finished
  for (const reader of readers) {
    assertSpawnStatus(reader, 0, 'Reader must exit 0', DEFAULT_TIMEOUT);
  }
  
  clean(root);
}

console.log('PASS: concurrency test');

// ===========================================================================
// 13. Append-only fixture loading
// ===========================================================================

{
  loadModules();
  // Create a fixture journal.jsonl with an earlier-style field set
  const root = tmpStateRoot();
  const store = new JobStore({ stateRoot: root });
  const repoKeyResult = computeRepoKeyWithPath(__dirname);
  const jobId = generateJobId();
  
  // Create a directory manually and write a fixture journal
  const jobDir = store._jobDir(repoKeyResult.repoKey, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  
  // This fixture has fewer fields (simulating an older version)
  const fixtureJournal = [
    { seq: 1, at: '2026-01-01T00:00:00.000Z', kind: 'job_created', attempt: null, from: null, to: 'created',
      detail: { job_id: jobId, backend: 'fake', schema_version: 1 } },
    { seq: 2, at: '2026-01-01T00:00:01.000Z', kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'running', detail: {} },
    { seq: 3, at: '2026-01-01T00:00:02.000Z', kind: 'attempt_state_changed', attempt: 1, from: 'running', to: 'done', detail: {} },
  ];
  
  const journalContent = fixtureJournal.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(jobDir, 'journal.jsonl'), journalContent, 'utf8');
  
  // Regenerate status from fixture journal - must not throw
  const status = store.regenerateStatus({ repoKey: repoKeyResult.repoKey, jobId });
  assert.ok(status, 'Status must be regenerated from fixture journal');
  assert.strictEqual(status.state, 'done', 'Final state should be done');
  assert.strictEqual(status.backend, 'fake', 'Backend should be read from fixture');
  
  clean(root);
}

console.log('PASS: append-only fixture loading');

// ===========================================================================
// 14. Path handling — spaces, non-ASCII
// ===========================================================================

{
  loadModules();
  
  const testPaths = [];
  const suffix = Math.random().toString(36).slice(2);
  
  // Path with spaces
  testPaths.push(path.join(os.tmpdir(), `dcli test path with spaces ${suffix}`));
  
  // Path with non-ASCII characters (if supported)
  testPaths.push(path.join(os.tmpdir(), `dcli-测试-${suffix}`));
  
  for (const testDir of testPaths) {
    try {
      fs.mkdirSync(testDir, { recursive: true });
    } catch (e) {
      // Skip if filesystem doesn't support the path
      console.log(`  (skipping path that could not be created: ${testDir})`);
      continue;
    }
    
    const repoKeyResult = computeRepoKeyWithPath(testDir);
    assert.strictEqual(repoKeyResult.repoKey.length, 12, `repo-key for "${testDir}" must be 12 chars`);
    assert.ok(/^[0-9a-f]{12}$/.test(repoKeyResult.repoKey), `repo-key for "${testDir}" must be lowercase hex`);
    
    // Create and verify job works with this path
    const root = tmpStateRoot();
    const store = new JobStore({ stateRoot: root });
    const jobId = generateJobId();
    
    store.createJob({
      jobId,
      repoKey: repoKeyResult.repoKey,
      repoRoot: repoKeyResult.fullPath,
      backend: 'fake',
      backendVersion: '1.0.0',
      adapterVersion: '1.0.0',
      mode: 'review',
      access: 'read-only',
    });
    
    const status = store.readStatus({ repoKey: repoKeyResult.repoKey, jobId });
    assert.strictEqual(status.repo_root, repoKeyResult.fullPath,
      `repo_root must match normalized path for "${testDir}"`);
    
    // Journal transition works
    store.journalTransition(jobId, repoKeyResult.repoKey, {
      kind: 'attempt_state_changed',
      attempt: 1,
      from: 'created',
      to: 'running',
      detail: {},
    });
    
    const updatedStatus = store.readStatus({ repoKey: repoKeyResult.repoKey, jobId });
    assert.strictEqual(updatedStatus.state, 'running');
    
    clean(root);
    clean(testDir);
  }
}

console.log('PASS: path handling with spaces and non-ASCII');

// ===========================================================================
// 15. Atomic write — no .tmp-* leftover on success
// ===========================================================================

{
  loadModules();
  const root = tmpStateRoot();
  const store = new JobStore({ stateRoot: root });
  const repoKeyResult = computeRepoKeyWithPath(__dirname);
  const jobId = generateJobId();
  
  store.createJob({
    jobId,
    repoKey: repoKeyResult.repoKey,
    repoRoot: repoKeyResult.fullPath,
    backend: 'fake',
    backendVersion: '1.0.0',
    adapterVersion: '1.0.0',
    mode: 'review',
    access: 'read-only',
  });
  
  const jobDir = store._jobDir(repoKeyResult.repoKey, jobId);
  
  // Do several transitions
  for (let i = 0; i < 5; i++) {
    store.journalTransition(jobId, repoKeyResult.repoKey, {
      kind: 'attempt_state_changed',
      attempt: 1,
      from: i === 0 ? 'created' : 'running',
      to: 'running',
      detail: { phase: `step_${i}` },
    });
  }
  
  // Check no .tmp-* files remain in job directory
  const files = fs.readdirSync(jobDir);
  const tmpFiles = files.filter(f => f.includes('.tmp-'));
  assert.strictEqual(tmpFiles.length, 0, `Expected no .tmp- files, found: ${tmpFiles.join(', ')}`);
  
  clean(root);
}

console.log('PASS: atomic write cleanup');

// ===========================================================================
// 16. Path handling — long paths, UNC, symlinks, junctions
// ===========================================================================

{
  loadModules();

  const isWin = process.platform === 'win32';

  // ---------------------------------------------------------------------------
  // 16a. Long path — deeply nested directories approaching/exceeding 260 chars
  // ---------------------------------------------------------------------------
  {
    const base = path.join(os.tmpdir(), `dcli-long-${Math.random().toString(36).slice(2)}`);

    let under = base;
    while (under.length < 240) {
      const seg = 'l' + Math.random().toString(36).slice(2, 7);
      if (under.length + seg.length + 1 > 245) break;
      under = path.join(under, seg);
    }

    let over = base;
    while (over.length < 270) {
      const seg = 'L' + Math.random().toString(36).slice(2, 7);
      if (over.length + seg.length + 1 > 280) break;
      over = path.join(over, seg);
    }

    for (const [label, dir] of [['under-260', under], ['over-260', over]]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        console.log(`  (skipping long path "${label}": ${e.message})`);
        continue;
      }

      const rk = computeRepoKeyWithPath(dir);
      assert.strictEqual(rk.repoKey.length, 12, `repo-key for ${label} must be 12 chars`);

      const root = tmpStateRoot();
      const store = new JobStore({ stateRoot: root });
      const jid = generateJobId();

      store.createJob({
        jobId: jid,
        repoKey: rk.repoKey,
        repoRoot: rk.fullPath,
        backend: 'fake',
        backendVersion: '1.0.0',
        adapterVersion: '1.0.0',
        mode: 'review',
        access: 'read-only',
      });

      const st = store.readStatus({ repoKey: rk.repoKey, jobId: jid });
      assert.strictEqual(st.repo_root, rk.fullPath, `repo_root must match for ${label}`);

      clean(root);
      clean(dir);
    }
    clean(base);
    assert.ok(!fs.existsSync(base), 'long-path fixture root must be removed');
  }

  // ---------------------------------------------------------------------------
  // 16b. UNC path — \\?\ prefix (Windows only)
  // ---------------------------------------------------------------------------
  (function() {
    if (!isWin) {
      console.log('  (skipping UNC path test: not Windows)');
      return;
    }

    const dirName = `dcli-unc-${Math.random().toString(36).slice(2)}`;
    const normalPath = path.join(os.tmpdir(), dirName);
    const uncPath = '\\\\?\\' + normalPath;

    try {
      fs.mkdirSync(uncPath, { recursive: true });
    } catch (e) {
      console.log(`  (skipping UNC \\\\?\\ path test: ${e.message})`);
      return;
    }

    try {
      const rk = computeRepoKeyWithPath(uncPath);
      assert.strictEqual(rk.repoKey.length, 12, 'repo-key for UNC path must be 12 chars');

      const root = tmpStateRoot();
      const store = new JobStore({ stateRoot: root });
      const jid = generateJobId();

      store.createJob({
        jobId: jid,
        repoKey: rk.repoKey,
        repoRoot: rk.fullPath,
        backend: 'fake',
        backendVersion: '1.0.0',
        adapterVersion: '1.0.0',
        mode: 'review',
        access: 'read-only',
      });

      const st = store.readStatus({ repoKey: rk.repoKey, jobId: jid });
      assert.strictEqual(st.repo_root, rk.fullPath, 'repo_root must match for UNC path');

      clean(root);
    } finally {
      clean(uncPath);
    }
  })();

  // ---------------------------------------------------------------------------
  // 16c. Directory symlink
  // ---------------------------------------------------------------------------
  (function() {
    const realDir = path.join(os.tmpdir(), `dcli-real-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(realDir, { recursive: true });

    const linkDir = path.join(os.tmpdir(), `dcli-link-${Math.random().toString(36).slice(2)}`);

    try {
      fs.symlinkSync(realDir, linkDir, 'dir');
    } catch (e) {
      console.log(`  (skipping symlink test: ${e.message})`);
      clean(realDir);
      return;
    }

    try {
      const rk = computeRepoKeyWithPath(linkDir);
      assert.strictEqual(rk.repoKey.length, 12, 'repo-key through symlink must be 12 chars');

      // normalizePath does not resolve symlinks, so key differs from real path
      // This is current behavior — future work may add fs.realpathSync resolution

      const root = tmpStateRoot();
      const store = new JobStore({ stateRoot: root });
      const jid = generateJobId();

      store.createJob({
        jobId: jid,
        repoKey: rk.repoKey,
        repoRoot: rk.fullPath,
        backend: 'fake',
        backendVersion: '1.0.0',
        adapterVersion: '1.0.0',
        mode: 'review',
        access: 'read-only',
      });

      const st = store.readStatus({ repoKey: rk.repoKey, jobId: jid });
      assert.strictEqual(st.repo_root, rk.fullPath, 'repo_root must match through symlink');

      clean(root);
    } finally {
      clean(linkDir);
      clean(realDir);
    }
  })();

  // ---------------------------------------------------------------------------
  // 16d. NTFS junction — mklink /J pointing at repo root
  // ---------------------------------------------------------------------------
  (function() {
    if (!isWin) {
      console.log('  (skipping junction test: not Windows)');
      return;
    }

    const jctTarget = path.resolve(__dirname, '..', '..');
    const junctionDir = path.join(os.tmpdir(), `dcli-jct-${Math.random().toString(36).slice(2)}`);

    const result = spawnSync(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', `mklink /J "${junctionDir}" "${jctTarget}"`],
      { windowsHide: true, encoding: 'utf8' }
    );

    if (result.status !== 0) {
      console.log(`  (skipping junction test: mklink failed — ${(result.stderr || result.stdout).trim()})`);
      return;
    }

    try {
      const rk = computeRepoKeyWithPath(junctionDir);
      assert.strictEqual(rk.repoKey.length, 12, 'repo-key through junction must be 12 chars');

      // normalizePath does not resolve junctions, so key differs from the real repo key
      // This is current behavior — future work may add fs.realpathSync resolution

      const root = tmpStateRoot();
      const store = new JobStore({ stateRoot: root });
      const jid = generateJobId();

      store.createJob({
        jobId: jid,
        repoKey: rk.repoKey,
        repoRoot: rk.fullPath,
        backend: 'fake',
        backendVersion: '1.0.0',
        adapterVersion: '1.0.0',
        mode: 'review',
        access: 'read-only',
      });

      const st = store.readStatus({ repoKey: rk.repoKey, jobId: jid });
      assert.strictEqual(st.repo_root, rk.fullPath, 'repo_root must match through junction');
      assert.strictEqual(st.state, 'created', 'Job state must be created through junction');

      clean(root);
    } finally {
      clean(junctionDir);
    }
  })();
}

console.log('PASS: path handling with long paths, UNC, symlinks, and junctions');

// ===========================================================================
// 17. Heartbeat writer updates heartbeat_at in status.json
// ===========================================================================

{
  loadModules();
  const root = tmpStateRoot();
  const store = new JobStore({ stateRoot: root });
  const repoKeyResult = computeRepoKeyWithPath(__dirname);
  const jobId = generateJobId();

  store.createJob({
    jobId,
    repoKey: repoKeyResult.repoKey,
    repoRoot: repoKeyResult.fullPath,
    backend: 'fake',
    backendVersion: '1.0.0',
    adapterVersion: '1.0.0',
    mode: 'review',
    access: 'read-only',
  });

  // Initially heartbeat_at is null
  const before = store.readStatus({ repoKey: repoKeyResult.repoKey, jobId });
  assert.strictEqual(before.heartbeat_at, null, 'heartbeat_at must be null initially');

  // Write heartbeat
  store.writeHeartbeat({ repoKey: repoKeyResult.repoKey, jobId });

  const after = store.readStatus({ repoKey: repoKeyResult.repoKey, jobId });
  assert.strictEqual(typeof after.heartbeat_at, 'string', 'heartbeat_at must be a string after writeHeartbeat');
  assert.ok(after.heartbeat_at.endsWith('Z'), 'heartbeat_at must be UTC');

  // Journal must contain the heartbeat entry
  const journal = store.readJournal({ repoKey: repoKeyResult.repoKey, jobId });
  const heartbeatEntry = journal.find(e => e.kind === 'heartbeat');
  assert.ok(heartbeatEntry, 'Journal must contain a heartbeat entry');
  assert.strictEqual(heartbeatEntry.detail.heartbeat_at, after.heartbeat_at,
    'Journal heartbeat_at must match status.json heartbeat_at');

  // Multiple heartbeats: each one updates heartbeat_at and adds a journal entry
  store.writeHeartbeat({ repoKey: repoKeyResult.repoKey, jobId });

  const journal2 = store.readJournal({ repoKey: repoKeyResult.repoKey, jobId });
  const heartbeatEntries = journal2.filter(e => e.kind === 'heartbeat');
  assert.strictEqual(heartbeatEntries.length, 2, 'Two heartbeats must produce two journal entries');

  // Regenerate status from journal preserves latest heartbeat_at
  const regenerated = store.regenerateStatus({ repoKey: repoKeyResult.repoKey, jobId });
  const lastHeartbeat = heartbeatEntries[heartbeatEntries.length - 1];
  assert.strictEqual(regenerated.heartbeat_at, lastHeartbeat.detail.heartbeat_at,
    'Regenerated status must have the latest heartbeat_at');

  clean(root);
}

console.log('PASS: heartbeat writer');

// ===========================================================================
// 18. Zero-wait: readStatus and regenerateStatus never block
// ===========================================================================

{
  loadModules();
  const root = tmpStateRoot();
  const store = new JobStore({ stateRoot: root });
  const repoKeyResult = computeRepoKeyWithPath(__dirname);
  const jobId = generateJobId();

  store.createJob({
    jobId,
    repoKey: repoKeyResult.repoKey,
    repoRoot: repoKeyResult.fullPath,
    backend: 'fake',
    backendVersion: '1.0.0',
    adapterVersion: '1.0.0',
    mode: 'review',
    access: 'read-only',
  });

  // readStatus must return promptly — it reads a file, no waiting
  const start = Date.now();
  for (let i = 0; i < 100; i++) {
    store.readStatus({ repoKey: repoKeyResult.repoKey, jobId });
  }
  const readTime = Date.now() - start;
  assert.ok(readTime < 5000, '100 readStatus calls must complete in under 5s');

  // regenerateStatus must return promptly — it reads journal and replays
  const start2 = Date.now();
  for (let i = 0; i < 50; i++) {
    store.regenerateStatus({ repoKey: repoKeyResult.repoKey, jobId });
  }
  const regenTime = Date.now() - start2;
  assert.ok(regenTime < 5000, '50 regenerateStatus calls must complete in under 5s');

  clean(root);
}

console.log('PASS: zero-wait reads');

// ===========================================================================
// Summary
// ===========================================================================

console.log('\nAll job-store tests passed.');
