// @suite full
// @serial  live backend; worktree operations
// @timeout-ms 600000
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const OPENCODE_LIVE_SMOKE = process.env.DCLI_OPENCODE_LIVE_SMOKE;
const { computeRepoKeyWithPath } = require('../../../core/repo-key');
const { JobStore } = require('../../../core/job-store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-p4-'));
}
function clean(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

function dcli(args, opts = {}) {
  return cp.spawnSync(process.execPath, [
    path.resolve(__dirname, '..', '..', '..', 'cli', 'dcli-opencode.js'),
    ...args,
  ], {
    encoding: 'utf8', windowsHide: true,
    timeout: opts.timeout || 120000,
    env: opts.env ? { ...process.env, ...opts.env } : { ...process.env },
  });
}

async function main() {
  if (!OPENCODE_LIVE_SMOKE || OPENCODE_LIVE_SMOKE === '0') {
    console.log('SKIP: DCLI_OPENCODE_LIVE_SMOKE not set');
    return;
  }

  // ==========================================================================
  // P4.1 — Implement mode: run creates worktree, produces diffable result
  // ==========================================================================
  {
    const repoDir = tmpDir();
    const stateRoot = tmpDir();
    const env = { DCLI_STATE_ROOT: stateRoot };

    cp.spawnSync('git', ['init'], { cwd: repoDir, windowsHide: true });
    cp.spawnSync('git', ['config', 'user.email', 'test@dcli.local'], { cwd: repoDir, windowsHide: true });
    cp.spawnSync('git', ['config', 'user.name', 'dcli test'], { cwd: repoDir, windowsHide: true });
    // Create an initial commit so the worktree has a base
    fs.writeFileSync(path.join(repoDir, 'readme.md'), '# Test\n', 'utf8');
    cp.spawnSync('git', ['add', 'readme.md'], { cwd: repoDir, windowsHide: true });
    cp.spawnSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, windowsHide: true });

    let jobId = null;
    try {
      const r = dcli([
        'run',
        '--mode', 'implement',
        '--hard-timeout-sec', '120',
        '--model', 'opencode-go/deepseek-v4-flash',
        '--access', 'workspace',
        '--repo', repoDir,
        'Create a file called hello.txt containing exactly: IMPLEMENT_MODE_WORKS',
        '--json',
      ], { env, timeout: 180000 });

      let parsed = null;
      try { parsed = JSON.parse((r.stdout || '').trim()); } catch {}
      assert.strictEqual(r.status, 0, `implement must exit 0: ${r.stderr}`);
      assert.ok(parsed, `implement --json output must be valid JSON: ${(r.stdout || '').slice(0, 200)}`);
      assert.strictEqual(
        parsed.state, 'done',
        `Implement mode must complete as done, got ${parsed.state}. failure_reason: ${parsed.failure_reason || 'none'}`
      );
      jobId = parsed.job_id;
      assert.ok(jobId, 'implement --json envelope must carry a job_id');
      console.log(`P4.1 implement run: state=${parsed.state}, job_id=${jobId}`);

      // diff should produce output
      const diffR = dcli([
        'diff', jobId,
        '--repo', repoDir,
        '--stat',
      ], { env, timeout: 30000 });
      console.log(`P4.1 diff exit: ${diffR.status}, stdout: ${(diffR.stdout || '').slice(0, 200)}`);
      // diff exit 0 means it found changes
      assert.strictEqual(diffR.status, 0, `diff must succeed or report changes: ${diffR.stderr}`);

      console.log('PASS: P4.1 implement mode with opencode — run + diff');
    } finally {
      clean(repoDir);
      clean(stateRoot);
    }
  }

  // ==========================================================================
  // P4.2 — Lineage: parent_job_id and root_job_id preserved through resume
  // ==========================================================================
  {
    const repoDir = tmpDir();
    const stateRoot = tmpDir();
    const env = { DCLI_STATE_ROOT: stateRoot };

    cp.spawnSync('git', ['init'], { cwd: repoDir, windowsHide: true });
    cp.spawnSync('git', ['config', 'user.email', 'test@dcli.local'], { cwd: repoDir, windowsHide: true });
    cp.spawnSync('git', ['config', 'user.name', 'dcli test'], { cwd: repoDir, windowsHide: true });
    fs.writeFileSync(path.join(repoDir, 'readme.md'), '# Test\n', 'utf8');
    cp.spawnSync('git', ['add', 'readme.md'], { cwd: repoDir, windowsHide: true });
    cp.spawnSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, windowsHide: true });

    try {
      // A random nonce is planted in the parent turn. The child prompt then
      // asks the continued session to recall it — a value that exists only in
      // the parent's conversation context, never in the filesystem (resume in
      // implement mode seeds a fresh worktree, not the parent's result commit).
      // If continue_backend_session silently starts a new session, the child
      // cannot answer, and the assertion fails. Session-id equality alone is
      // not proof: the id can be copied without loading its context.
      const nonce = 'LINEAGE_' + Math.random().toString(36).slice(2, 10);

      const parentR = dcli([
        'run',
        '--mode', 'implement',
        '--hard-timeout-sec', '180',
        '--model', 'opencode-go/deepseek-v4-flash',
        '--access', 'workspace',
        '--repo', repoDir,
        `Create a file called lineage.txt containing exactly: ${nonce}`,
        '--json',
      ], { env, timeout: 240000 });

      let parentParsed = null;
      try { parentParsed = JSON.parse((parentR.stdout || '').trim()); } catch {}
      assert.strictEqual(parentR.status, 0, `parent implement must exit 0: ${parentR.stderr}`);
      assert.ok(parentParsed, `parent implement --json must be valid JSON`);
      const parentJobId = parentParsed.job_id;
      console.log(`P4.2 parent job: ${parentJobId}, state=${parentParsed.state}`);

      // Fail loudly when the parent did not complete, never skip the lineage
      // assertions and report PASS. A real backend can return a valid envelope
      // with state failed/timed_out; that is exactly when the resume path must
      // be exercised, not silently bypassed.
      assert.strictEqual(parentParsed.state, 'done',
        `parent implement must complete as done, got ${parentParsed.state}. failure_reason: ${parentParsed.failure_reason || 'none'}`);
      assert.ok(parentJobId, 'parent job_id must be set');

      // Resume the parent job. continue_backend_session requires the parent
      // to have a backend_session_id (recorded live), which the done parent
      // does; it is the kind that exercises real session continuation.
      const resumeR = dcli([
        'resume', parentJobId,
        '--repo', repoDir,
        '--model', 'opencode-go/deepseek-v4-flash',
        '--access', 'workspace',
        '--kind', 'continue_backend_session',
        `Recall the exact value I asked you to write into lineage.txt in the previous turn (the ${nonce.slice(0, 7)}... value). Reply with only that value and nothing else.`,
        '--json',
      ], { env, timeout: 240000 });

      let resumeParsed = null;
      try { resumeParsed = JSON.parse((resumeR.stdout || '').trim()); } catch {}
      assert.strictEqual(resumeR.status, 0, `resume must exit 0: ${resumeR.stderr}`);
      assert.ok(resumeParsed, 'resume --json must return valid JSON');
      assert.strictEqual(resumeParsed.state, 'done',
        `resume must complete as done, got ${resumeParsed.state}. failure_reason: ${resumeParsed.failure_reason || 'none'}`);

      // The resume envelope carries job_id only; parent_job_id/root_job_id
      // live on the child's status. Read the child's durable status to
      // assert lineage.
      const { repoKey } = computeRepoKeyWithPath(repoDir);
      const childStore = new JobStore({ stateRoot });
      const childStatus = childStore.readStatus({ repoKey, jobId: resumeParsed.job_id });
      const rootId = childStatus.root_job_id;
      const parentId = childStatus.parent_job_id;
      assert.ok(rootId, 'root_job_id must be set on the resumed job');
      assert.ok(parentId, 'parent_job_id must be set on the resumed job');
      assert.strictEqual(parentId, parentJobId,
        `parent_job_id (${parentId}) must equal the resumed job (${parentJobId})`);
      assert.strictEqual(rootId, parentJobId,
        `root_job_id (${rootId}) must equal the parent job (${parentJobId})`);

      // The session must actually have been continued: the child's durable
      // result must contain the nonce, which no fresh session could know.
      const childAttemptDir = path.join(
        stateRoot, 'jobs', repoKey, resumeParsed.job_id, 'attempts', '1'
      );
      const childResultPath = path.join(childAttemptDir, 'result.md');
      assert.ok(fs.existsSync(childResultPath), `child result.md must exist (${childResultPath})`);
      const childResult = fs.readFileSync(childResultPath, 'utf8');
      assert.ok(childResult.includes(nonce),
        `continued session must recall the parent's nonce; child result did not contain ${nonce}. result: ${childResult.slice(0, 300)}`);
      console.log(`P4.2 lineage: root=${rootId}, parent=${parentId}, session continued (nonce recalled)`);

      console.log('PASS: P4.2 lineage — resume chain verified');
    } finally {
      clean(repoDir);
      clean(stateRoot);
    }
  }

  console.log('\nAll P4 apply and lineage tests passed.');
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
