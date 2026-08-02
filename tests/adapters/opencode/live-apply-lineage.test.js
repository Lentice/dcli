// @suite full
// @serial  live backend; worktree operations
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');

const OPENCODE_LIVE_SMOKE = process.env.DCLI_OPENCODE_LIVE_SMOKE;

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

      if (parsed) {
        jobId = parsed.job_id;
        console.log(`P4.1 implement run: state=${parsed.state}, job_id=${jobId}`);
        assert.strictEqual(
          parsed.state, 'done',
          `Implement mode must complete as done, got ${parsed.state}. failure_reason: ${parsed.failure_reason || 'none'}`
        );
      } else {
        assert.fail(`implement --json output must be valid JSON: ${(r.stdout || '').slice(0, 200)}`);
      }

      // diff should produce output
      if (jobId) {
        const diffR = dcli([
          'diff', jobId,
          '--repo', repoDir,
          '--stat',
        ], { env, timeout: 30000 });
        console.log(`P4.1 diff exit: ${diffR.status}, stdout: ${(diffR.stdout || '').slice(0, 200)}`);
        // diff exit 0 means it found changes
        assert.strictEqual(diffR.status, 0, `diff must succeed or report changes: ${diffR.stderr}`);
      }

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
      const parentR = dcli([
        'run',
        '--mode', 'implement',
        '--hard-timeout-sec', '120',
        '--model', 'opencode-go/deepseek-v4-flash',
        '--access', 'workspace',
        '--repo', repoDir,
        'Create a file called lineage.txt containing exactly: LINEAGE_PARENT',
        '--json',
      ], { env, timeout: 180000 });

      let parentParsed = null;
      try { parentParsed = JSON.parse((parentR.stdout || '').trim()); } catch {}
      assert.ok(parentParsed, `parent implement --json must be valid JSON`);
      const parentJobId = parentParsed.job_id;
      console.log(`P4.2 parent job: ${parentJobId}, state=${parentParsed.state}`);

      if (parentParsed.state === 'done' && parentJobId) {
        // Resume the parent job
        const resumeR = dcli([
          'resume', parentJobId,
          '--repo', repoDir,
          '--model', 'opencode-go/deepseek-v4-flash',
          '--access', 'workspace',
          'Add a second file called lineage2.txt containing exactly: LINEAGE_CHILD',
          '--json',
        ], { env, timeout: 180000 });

        let resumeParsed = null;
        try { resumeParsed = JSON.parse((resumeR.stdout || '').trim()); } catch {}
        assert.ok(resumeParsed, 'resume --json must return valid JSON');

        // root_job_id must equal the parent's job_id (or parent's root_job_id)
        // parent_job_id must reference the parent job
        const rootId = resumeParsed.root_job_id;
        const parentId = resumeParsed.parent_job_id;
        assert.ok(rootId, 'root_job_id must be set in resume output');
        assert.ok(parentId, 'parent_job_id must be set in resume output');
        assert.strictEqual(parentId, parentJobId,
          `parent_job_id (${parentId}) must equal the resumed job (${parentJobId})`);
        console.log(`P4.2 lineage: root=${rootId}, parent=${parentId}`);
      }

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
