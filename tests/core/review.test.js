const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { FakeAdapter } = require('../../adapters/fake/adapter');
const { JobStore } = require('../../core/job-store');
const { buildReviewPrompt, generateDiff, executeReview, getDroppedFilesFromDiff, DIFF_CAP_BYTES, UNTRACKED_SIZE_LIMIT } = require('../../core/commands/review');
const { parseFindings } = require('../../core/findings');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-review-test-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return fn(dir).then(cleanup, (err) => { cleanup(); throw err; });
}

function initGitRepo(dir) {
  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8', windowsHide: true });
}

function gitAddCommit(dir, msg) {
  spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  spawnSync('git', ['commit', '-m', msg], { cwd: dir, encoding: 'utf8', windowsHide: true });
}

async function main() {

// ===========================================================================
// 1. buildReviewPrompt includes the diff and framing text
// ===========================================================================
{
  const diffInfo = {
    diff: '--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new',
    truncated: false,
    totalBytes: 50,
    truncationInfo: null,
    untrackedWarning: null,
    untrackedFiles: [],
  };

  const prompt = buildReviewPrompt({ diffInfo, intent: 'Review caching logic', focus: 'performance' });
  assert.ok(prompt.includes('Intent: Review caching logic'), 'prompt must include intent');
  assert.ok(prompt.includes('Focus: performance'), 'prompt must include focus');
  assert.ok(prompt.includes('not evidence of correctness'), 'prompt must have framing text');
  assert.ok(prompt.includes('```diff'), 'prompt must include diff block');
  assert.ok(prompt.includes('old\n+new'), 'prompt must include diff content');
  assert.ok(prompt.includes('<!-- dcli:findings -->'), 'prompt must mention findings marker');
  assert.ok(prompt.includes('Order findings by severity'), 'prompt must mention severity ordering');
  console.log('PASS: review test 1 — prompt building');
}

// ===========================================================================
// 2. buildReviewPrompt includes truncation warning with file names
// ===========================================================================
{
  const diffInfo = {
    diff: '--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new\n[... diff truncated ...]\n',
    truncated: true,
    totalBytes: 150000,
    truncationInfo: 'Diff truncated: 150000 bytes total, showing first 100000 bytes. Dropped or partially dropped files: big3.js, big4.js.',
    untrackedWarning: null,
    untrackedFiles: [],
  };

  const prompt = buildReviewPrompt({ diffInfo });
  assert.ok(prompt.includes('Diff truncated'), 'prompt must include truncation info');
  assert.ok(prompt.includes('150000 bytes'), 'truncation info must mention byte count');
  assert.ok(prompt.includes('Dropped or partially dropped files: big3.js, big4.js'), 'truncation must name dropped files');
  console.log('PASS: review test 2 — truncation in prompt with file names');
}

// ===========================================================================
// 3. buildReviewPrompt includes untracked warning
// ===========================================================================
{
  const diffInfo = {
    diff: '--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new',
    truncated: false,
    totalBytes: 50,
    truncationInfo: null,
    untrackedWarning: 'Warning: 2 untracked file(s) not included in diff. Use --include-untracked to include them.',
    untrackedFiles: ['new1.js', 'new2.js'],
  };

  const prompt = buildReviewPrompt({ diffInfo });
  assert.ok(prompt.includes('untracked'), 'prompt must include untracked warning');
  assert.ok(prompt.includes('--include-untracked'), 'prompt must mention --include-untracked');
  console.log('PASS: review test 3 — untracked warning in prompt');
}

// ===========================================================================
// 4. executeReview forces access to read-only
// ===========================================================================
{
  try {
    executeReview({ store: null, adapter: null, repoKey: 'test', repoRoot: '/tmp', access: 'full' });
    assert.fail('Should have thrown for non-read-only access');
  } catch (err) {
    assert.strictEqual(err.exitCode, 2, 'wrong access must throw exit 2');
    assert.ok(err.message.includes('read-only'), 'error must mention read-only');
  }
  console.log('PASS: review test 4 — access forced to read-only');
}

// ===========================================================================
// 5. generateDiff in a git repo — working tree diff
// ===========================================================================
await withTempDir(async (dir) => {
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, 'readme.md'), '# Initial\n', 'utf8');
  gitAddCommit(dir, 'initial');
  fs.writeFileSync(path.join(dir, 'readme.md'), '# Updated\n', 'utf8');

  const info = generateDiff({ repoRoot: dir, scope: 'working', embedDiff: true });
  assert.ok(info.diff.length > 0, 'diff must not be empty');
  assert.ok(info.diff.includes('readme.md') || info.diff.includes('Updated'), 'diff must include changed file');
  assert.strictEqual(info.truncated, false, 'small diff must not be truncated');
  console.log('PASS: review test 5 — working tree diff');
});

// ===========================================================================
// 6. generateDiff — staged diff
// ===========================================================================
await withTempDir(async (dir) => {
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, 'readme.md'), '# Initial\n', 'utf8');
  gitAddCommit(dir, 'initial');
  fs.writeFileSync(path.join(dir, 'readme.md'), '# Staged\n', 'utf8');
  spawnSync('git', ['add', 'readme.md'], { cwd: dir, encoding: 'utf8', windowsHide: true });

  const info = generateDiff({ repoRoot: dir, scope: 'staged', embedDiff: true });
  assert.ok(info.diff.length > 0, 'staged diff must not be empty');
  assert.ok(info.diff.includes('Staged'), 'staged diff must include staged content');
  console.log('PASS: review test 6 — staged diff');
});

// ===========================================================================
// 7. generateDiff — range diff
// ===========================================================================
await withTempDir(async (dir) => {
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a1\n', 'utf8');
  gitAddCommit(dir, 'first');
  const firstHash = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', windowsHide: true }).stdout.trim();

  fs.writeFileSync(path.join(dir, 'b.txt'), 'b1\n', 'utf8');
  gitAddCommit(dir, 'second');

  const info = generateDiff({ repoRoot: dir, scope: 'range', rangeBase: firstHash, rangeHead: 'HEAD', embedDiff: true });
  assert.ok(info.diff.length > 0, 'range diff must not be empty');
  console.log('PASS: review test 7 — range diff');
});

// ===========================================================================
// 8. generateDiff — --path filtering
// ===========================================================================
await withTempDir(async (dir) => {
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, 'keep.js'), '// keep\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'ignore.py'), '# ignore\n', 'utf8');
  gitAddCommit(dir, 'initial');
  fs.writeFileSync(path.join(dir, 'keep.js'), '// keep updated\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'ignore.py'), '# ignore updated\n', 'utf8');

  const info = generateDiff({ repoRoot: dir, scope: 'working', paths: ['keep.js'], embedDiff: true });
  assert.ok(info.diff.includes('keep.js'), 'diff must include keep.js');
  assert.ok(!info.diff.includes('ignore.py'), 'diff must not include ignore.py');
  console.log('PASS: review test 8 — path filtering');
});

// ===========================================================================
// 9. generateDiff — untracked files warning when not included
// ===========================================================================
await withTempDir(async (dir) => {
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'tracked\n', 'utf8');
  gitAddCommit(dir, 'initial');
  fs.writeFileSync(path.join(dir, 'untracked.js'), '// new file\n', 'utf8');

  const info = generateDiff({ repoRoot: dir, scope: 'working', includeUntracked: false, embedDiff: true });
  assert.ok(info.untrackedFiles.length > 0, 'must detect untracked files');
  assert.ok(info.untrackedWarning.includes('untracked'), 'warning must mention untracked');
  console.log('PASS: review test 9 — untracked file warning');
});

// ===========================================================================
// 10. generateDiff — --include-untracked includes them
// ===========================================================================
await withTempDir(async (dir) => {
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'tracked\n', 'utf8');
  gitAddCommit(dir, 'initial');
  fs.writeFileSync(path.join(dir, 'newfile.js'), '// new file content\n', 'utf8');

  const info = generateDiff({ repoRoot: dir, scope: 'working', includeUntracked: true, embedDiff: true });
  assert.ok(info.diff.includes('newfile.js'), 'untracked file must be in diff content');
  assert.ok(info.diff.includes('new file content'), 'untracked file content must be included');
  console.log('PASS: review test 10 — include-untracked includes files');
});

// ===========================================================================
// 11. executeReview integrates with FakeAdapter and returns findings
// ===========================================================================
await withTempDir(async (dir) => {
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, 'file.js'), '// v1\n', 'utf8');
  gitAddCommit(dir, 'initial');
  fs.writeFileSync(path.join(dir, 'file.js'), '// v2\n', 'utf8');

  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_review' },
      { type: 'assistant_text', message_id: 'm1', text: 'Analysis:\n\n<!-- dcli:findings -->\n```json\n{"verdict":"Good.","items":[]}\n```' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const output = await executeReview({
    store, adapter,
    repoKey: 'test-repo',
    repoRoot: dir,
    prompt: '',
    hardTimeoutSec: 60,
    admission: null,
    reviewScope: 'working',
    includeUntracked: false,
    embedDiff: true,
    intent: 'Review test',
    paths: null,
  });

  assert.strictEqual(output.envelope.findings_status, 'ok', 'findings_status must be ok');
  assert.ok(output.envelope.findings, 'findings data must be present');
  assert.strictEqual(output.envelope.findings.verdict, 'Good.');
  console.log('PASS: review test 11 — executeReview with FakeAdapter');
});

// ===========================================================================
// 12. executeReview with malformed findings
// ===========================================================================
await withTempDir(async (dir) => {
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, 'file.js'), '// v1\n', 'utf8');
  gitAddCommit(dir, 'initial');
  fs.writeFileSync(path.join(dir, 'file.js'), '// v2\n', 'utf8');

  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_bad' },
      { type: 'assistant_text', message_id: 'm1', text: 'Analysis.\n\n<!-- dcli:findings -->\n```json\n{BROKEN JSON\n```' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const output = await executeReview({
    store, adapter,
    repoKey: 'test-repo',
    repoRoot: dir,
    prompt: '',
    hardTimeoutSec: 60,
    admission: null,
    reviewScope: 'working',
    includeUntracked: false,
    embedDiff: true,
    intent: 'Review test',
    paths: null,
  });

  assert.strictEqual(output.envelope.findings_status, 'malformed', 'malformed findings must be detected');
  console.log('PASS: review test 12 — malformed findings detected');
});

// ===========================================================================
// 13. --embed-diff false skips diff
// ===========================================================================
{
  const info = generateDiff({ repoRoot: '/tmp', scope: 'working', embedDiff: false });
  assert.ok(info.diff.includes('disabled'), 'diff must indicate disabled');
  console.log('PASS: review test 13 — embed-diff false');
}

// ===========================================================================
// 14. parseFindings called on review result returns correct status
// ===========================================================================
{
  const { parseFindings } = require('../../core/findings');
  const result = parseFindings('x\n\n<!-- dcli:findings -->\n```json\n{"verdict":"Done.","items":[]}\n```');
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.data.verdict, 'Done.');

  const result2 = parseFindings('just prose');
  assert.strictEqual(result2.status, 'absent');

  const result3 = parseFindings('x\n\n<!-- dcli:findings -->\n```json\n{BAD\n```');
  assert.strictEqual(result3.status, 'malformed');
  console.log('PASS: review test 14 — parseFindings integration');
}

// ===========================================================================
// 15. generateDiff — diff truncation with multiple files names dropped files
// ===========================================================================
await withTempDir(async (dir) => {
  initGitRepo(dir);
  const FILE_COUNT = 4;
  for (let i = 1; i <= FILE_COUNT; i++) {
    fs.writeFileSync(path.join(dir, `big${i}.js`), 'x\n', 'utf8');
  }
  gitAddCommit(dir, 'initial');

  const largeContent = 'y'.repeat(35000);
  for (let i = 1; i <= FILE_COUNT; i++) {
    fs.writeFileSync(path.join(dir, `big${i}.js`), largeContent, 'utf8');
  }

  const info = generateDiff({ repoRoot: dir, scope: 'working', embedDiff: true });
  assert.ok(info.truncated, 'large diff must be truncated');
  assert.ok(info.truncationInfo.includes('Dropped or partially dropped files:'), 'truncationInfo must list files');
  assert.ok(info.truncationInfo.includes('big3.js') || info.truncationInfo.includes('big4.js'), 'truncationInfo must name affected files');
  assert.ok(info.truncationInfo.includes(info.totalBytes.toString()), 'truncationInfo must mention total bytes');
  console.log('PASS: review test 15 — diff truncation names dropped files');
});

// ===========================================================================
// 16. generateDiff — untracked truncation with file names
// ===========================================================================
await withTempDir(async (dir) => {
  initGitRepo(dir);
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'tracked\n', 'utf8');
  gitAddCommit(dir, 'initial');

  const fileContent = 'z'.repeat(20000);
  for (let i = 1; i <= 4; i++) {
    fs.writeFileSync(path.join(dir, `untracked${i}.js`), fileContent, 'utf8');
  }

  const info = generateDiff({ repoRoot: dir, scope: 'working', includeUntracked: true, embedDiff: true });
  assert.ok(info.truncationInfo, 'truncationInfo must be set for untracked truncation');
  assert.ok(info.truncationInfo.includes('Untracked content truncated'), 'truncationInfo must mention untracked truncation');
  assert.ok(info.truncationInfo.includes('files not shown:'), 'truncationInfo must list dropped files');
  assert.ok(info.truncationInfo.includes('untracked4.js'), 'truncationInfo must name dropped file');
  assert.ok(info.diff.includes('Untracked files truncated'), 'diff must contain truncation message');
  assert.ok(info.diff.includes('untracked4.js'), 'truncation message must name dropped file');
  assert.ok(info.diff.includes('### untracked1.js'), 'diff must include untracked1.js content');
  assert.ok(info.diff.includes('### untracked2.js'), 'diff must include untracked2.js content');
  assert.ok(info.diff.includes('[Untracked files truncated:'), 'diff truncation message must be present');
  console.log('PASS: review test 16 — untracked truncation with file names');
});

// ===========================================================================
// 17. executeReview envelope contains truncation_info
// ===========================================================================
await withTempDir(async (dir) => {
  initGitRepo(dir);
  const FILE_COUNT = 4;
  for (let i = 1; i <= FILE_COUNT; i++) {
    fs.writeFileSync(path.join(dir, `big${i}.js`), 'x\n', 'utf8');
  }
  gitAddCommit(dir, 'initial');

  const largeContent = 'y'.repeat(35000);
  for (let i = 1; i <= FILE_COUNT; i++) {
    fs.writeFileSync(path.join(dir, `big${i}.js`), largeContent, 'utf8');
  }

  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 1, backend_session_id: 'ses_trunc_env' },
      { type: 'assistant_text', message_id: 'm1', text: 'Analysis.\n\n<!-- dcli:findings -->\n```json\n{"verdict":"Good.","items":[]}\n```' },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });

  const output = await executeReview({
    store, adapter,
    repoKey: 'test-repo',
    repoRoot: dir,
    prompt: '',
    hardTimeoutSec: 60,
    admission: null,
    reviewScope: 'working',
    includeUntracked: false,
    embedDiff: true,
    intent: 'Review test',
    paths: null,
  });

  assert.ok(output.envelope.truncation_info, 'envelope must have truncation_info');
  assert.ok(output.envelope.truncation_info.includes('Dropped or partially dropped files:'), 'envelope truncation_info must name files');
  assert.ok('untracked_warning' in output.envelope, 'envelope must have untracked_warning field');
  console.log('PASS: review test 17 — executeReview envelope includes truncation_info');
});

// ===========================================================================
// Summary
// ===========================================================================
console.log('\nAll review command tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
