// Ticket 95 criterion E: the journal produced by run, resume and submit is
// byte-identical to the journal produced before this change, for one
// representative job each.
//
// Baselines were captured from the PRE-CHANGE code with
//   node tests/core/journal-byte-identity.test.js --capture
// and committed as tests/fixtures/journal-{run,resume,submit}-baseline.jsonl.
// Running the same file without --capture replays the flows against the new
// code and compares byte-for-byte. Only the values that legitimately vary
// between runs are normalised (timestamps, ids, tokens, pids, paths, commit
// hashes); journal kinds, detail keys, values and seq survive the comparison,
// so a renamed key, an added or removed entry, or a reordered one fails it.
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { JobStore } = require('../../core/job-store');
const { generateJobId } = require('../../core/job-id');
const { FakeAdapter } = require('../../adapters/fake/adapter');
const { executeRun } = require('../../core/commands/run');
const { executeResume } = require('../../core/commands/resume');
const { executeSubmit } = require('../../core/commands/submit');

const CAPTURE = process.argv.includes('--capture');
const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures');
const TERMINAL = ['done', 'failed', 'timed_out', 'cancelled', 'interrupted'];

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function createRepo(root) {
  const repoRoot = path.join(root, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  git(['init', '-b', 'main'], repoRoot);
  git(['config', 'user.email', 't@t.com'], repoRoot);
  git(['config', 'user.name', 'T'], repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# x\n', 'utf8');
  git(['add', '-A'], repoRoot);
  git(['commit', '-m', 'init'], repoRoot);
  return repoRoot;
}

// DEFAULT_FACTS: started(backend_pid 1, ses_default), assistant_text,
// usage_reported, process_exited 0 — every fact is deterministic.
function makeAdapter() {
  return new FakeAdapter();
}

function createParentJob(store, repoKey, repoRoot, resultCommit) {
  const jobId = generateJobId();
  store.createJob({
    jobId, repoKey, repoRoot,
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only', hardTimeoutSec: 600,
    capabilitiesSnapshot: {},
  });
  store.createAttemptDir({ repoKey, jobId, attemptNum: 1 });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created', attempt: 1, from: null, to: 'created',
    detail: { attempt_id: 'a1', execution_token: 'tok-parent' },
  });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'done',
    detail: {
      finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal',
      backend_session_id: 'ses_parent',
      worktree_path: 'parent-worktree',
      worktree_result_commit: resultCommit,
    },
  });
  return jobId;
}

async function runFlow(dir) {
  const repoRoot = createRepo(dir);
  const stateRoot = path.join(dir, 'state');
  const store = new JobStore({ stateRoot });
  const output = await executeRun({
    store, adapter: makeAdapter(), repoKey: 'byteid-run', repoRoot,
    prompt: 'run byte-identity', hardTimeoutSec: 60,
    mode: 'implement', stateRoot,
    group: 'g1', label: 'l1', model: 'm1', access: 'read-only',
  });
  return store.readJournal({ repoKey: 'byteid-run', jobId: output.jobId });
}

async function resumeFlow(dir) {
  const repoRoot = createRepo(dir);
  const stateRoot = path.join(dir, 'state');
  const store = new JobStore({ stateRoot });
  const headHash = git(['rev-parse', 'HEAD'], repoRoot);
  const parentJobId = createParentJob(store, 'byteid-resume', repoRoot, headHash);
  const result = await executeResume({
    store, adapter: makeAdapter(), repoKey: 'byteid-resume', repoRoot,
    prompt: 'resume byte-identity', kind: 'fork_from_artifacts', parentJobId,
    hardTimeoutSec: 60, mode: 'implement', stateRoot,
    group: 'g2', label: 'l2', model: 'm2', access: 'read-only',
  });
  return store.readJournal({ repoKey: 'byteid-resume', jobId: result.jobId });
}

async function submitFlow(dir) {
  const store = new JobStore({ stateRoot: dir });
  const result = await executeSubmit({
    store, adapter: makeAdapter(), repoKey: 'byteid-submit', repoRoot: dir,
    prompt: 'submit byte-identity', hardTimeoutSec: 60,
    group: 'g3', label: 'l3', model: 'm3', access: 'read-only',
    stateRoot: dir, backend: 'fake',
  });
  const jobId = result.jobId;
  const deadline = Date.now() + 60000;
  let status = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    try { status = store.readStatus({ repoKey: 'byteid-submit', jobId }); } catch {}
    if (status && TERMINAL.includes(status.state)) break;
  }
  assert.ok(status && TERMINAL.includes(status.state),
    `submit worker did not reach a terminal state; last: ${status && status.state}`);
  return store.readJournal({ repoKey: 'byteid-submit', jobId });
}

// Values that differ between identical runs. Everything else — kinds, keys,
// ordering, seq — must match byte for byte.
const VOLATILE_KEYS = new Set([
  'job_id', 'parent_job_id', 'root_job_id',
  'at', 'started_at', 'finished_at',
  'execution_token', 'worker_pid', 'worker_identity', 'backend_pid',
  'repo_root', 'worktree_path', 'worktree_base_commit', 'worktree_result_commit',
]);

function placeholderFor(key) {
  switch (key) {
    case 'at':
    case 'started_at':
    case 'finished_at': return '<iso>';
    case 'job_id':
    case 'parent_job_id':
    case 'root_job_id': return '<job-id>';
    case 'repo_root': return '<repo-root>';
    case 'worktree_path': return '<worktree-path>';
    case 'worktree_base_commit':
    case 'worktree_result_commit': return '<commit>';
    case 'execution_token': return '<token>';
    case 'worker_pid':
    case 'backend_pid': return '<pid>';
    case 'worker_identity': return '<worker-identity>';
    default: return '<value>';
  }
}

function normalizeValue(value) {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // null is a deterministic default, never a run-varying value: only a
      // non-null value under a volatile key is masked.
      out[k] = VOLATILE_KEYS.has(k) && v !== null ? placeholderFor(k) : normalizeValue(v);
    }
    return out;
  }
  return value;
}

// Canonical form matches the journal file's own line format
// (appendJsonLine: JSON.stringify(entry) + '\n').
function normalizeJournal(entries) {
  return entries.map(e => JSON.stringify(normalizeValue(e))).join('\n') + '\n';
}

async function main() {
  const flows = { run: runFlow, resume: resumeFlow, submit: submitFlow };
  for (const [name, flow] of Object.entries(flows)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dcli-journal-${name}-`));
    try {
      const normalized = normalizeJournal(await flow(dir));
      const fixturePath = path.join(FIXTURE_DIR, `journal-${name}-baseline.jsonl`);
      if (CAPTURE) {
        fs.writeFileSync(fixturePath, normalized, 'utf8');
        console.log(`CAPTURED: ${name} -> ${fixturePath}`);
      } else {
        const expected = fs.readFileSync(fixturePath, 'utf8');
        assert.strictEqual(normalized, expected,
          `journal-${name} must be byte-identical to the pre-change baseline`);
        console.log(`PASS: ${name} journal byte-identical to baseline`);
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
  console.log(CAPTURE ? '\nBaselines captured.' : '\nAll journal byte-identity tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
