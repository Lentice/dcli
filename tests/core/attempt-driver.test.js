// @suite full
// @serial  spawns one real worker for the characterization baseline
//
// Ticket 92 — one attempt driver for foreground and detached execution.
// `run` (foreground) and `submit`/worker (detached) were two copies of one
// algorithm that had drifted into four observable differences. This file is
// the regression net for the merge:
//
//   1. A characterization baseline proves the two paths journal identically
//      for an ordinary successful run (the safety net that must stay green
//      across the merge), snapshotted to a fixture file.
//   2. Criterion C: a foreground run responds to `dcli cancel` — the job
//      reaches `cancelled`, not `done` or `timed_out`.
//   3. Criterion D: a foreground hard timeout records `kill_skipped` with the
//      same value the worker path records.
//   4. Criterion E: a worktree-backed attempt records the worktree result
//      commit in its terminal detail.
//   5. Criterion F: a backend that reports no session id falls back to the
//      recorded `fallbackSessionId`.
//   6. Criterion G: `driveAttempt` runs in-process with an injected
//      cancelSignal and a fake adapter for hard timeout, cancellation and
//      result-persistence failure — none spawns a detached process.
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { JobStore } = require(path.join(ROOT, 'core', 'job-store'));
const { executeRun } = require(path.join(ROOT, 'core', 'commands', 'run'));
const { FakeAdapter } = require(path.join(ROOT, 'adapters', 'fake', 'adapter'));
const { createDetachedWorktree } = require(path.join(ROOT, 'core', 'worktree'));

const WORKER = path.join(ROOT, 'core', 'commands', 'worker.js');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'attempt-driver', 'baseline.json');

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const CAPABILITIES = {
  schema_version: 1,
  backend: 'fake',
  backend_version: '1.0.0',
  core: { run: true, submit: true },
  extensions: {},
};

// The exact script both paths execute so their journals can be compared.
const BASELINE_SCRIPT = {
  facts: [
    { type: 'started', backend_pid: 4242, backend_session_id: 'ses_baseline' },
    { type: 'assistant_text', message_id: 'm1', text: 'baseline result' },
    { type: 'usage_reported', tokens: { input: 1, output: 2, total: 3 } },
    { type: 'process_exited', code: 0 },
  ],
  exitCode: 0,
  declaredRungs: ['hard_kill'],
  capabilities: CAPABILITIES,
};

const REQUEST = {
  model: null,
  canonicalDir: process.cwd(),
  reasoningEffort: null,
  variant: null,
  effort: null,
  access: 'read-only',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function git(args, cwd) {
  return require('child_process').spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 't@t.com'], dir);
  git(['config', 'user.name', 'T'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n', 'utf8');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'init'], dir);
}

function seedJob(store, repoKey, jobId, repoRoot, { hardTimeoutSec = 60, capabilities = CAPABILITIES } = {}) {
  store.createJob({
    jobId, repoKey, repoRoot,
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
    hardTimeoutSec,
    capabilitiesSnapshot: capabilities,
  });
  store.createAttemptDir({ repoKey, jobId, attemptNum: 1 });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created', attempt: 1, from: null, to: 'created',
    detail: { attempt_id: 'attempt-1', execution_token: 'tok-seed' },
  });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'running',
    detail: {
      started_at: new Date().toISOString(), phase: 'agent_running',
      worker_pid: process.pid, worker_identity: `${process.pid};2020-01-01T00:00:00.000Z`,
    },
  });
}

// A cancelSignal backed by the shared cancel.request poller, exactly what
// run.js / worker.js hand to driveAttempt.
function fileCancelSignal(jobDir) {
  const { createCancelSignal } = require(path.join(ROOT, 'core', 'commands', 'attempt-driver'));
  return createCancelSignal({ jobDir });
}

// A plain injected cancelSignal for unit tests: no file, no timer.
function manualSignal() {
  let cancelled = false;
  return {
    cancel() { cancelled = true; },
    isCancelled: () => cancelled,
    dispose() {},
  };
}

async function killAndVerify(child) {
  if (!child) return Promise.resolve();
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), 15000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.once('error', () => { clearTimeout(timer); resolve(); });
    try { child.kill('SIGKILL'); } catch { clearTimeout(timer); resolve(); }
  });
}

function spawnWorker(stateRoot, backend, jobId, repoKey, repoRoot, hardTimeoutMs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DCLI_WORKER: '1',
        DCLI_STATE_ROOT: stateRoot,
        DCLI_BACKEND: backend,
        DCLI_JOB_ID: jobId,
        DCLI_REPO_KEY: repoKey,
        DCLI_REPO_ROOT: repoRoot,
        DCLI_WORKER_HARD_TIMEOUT_MS: String(hardTimeoutMs),
      },
    });
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const killTimer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
      reject(new Error(`Worker timed out after ${timeoutMs}ms:\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', c => { stdout += c.toString(); });
    child.stderr.on('data', c => { stderr += c.toString(); });
    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(killTimer);
      resolve({ exitCode: code, stdout, stderr });
    });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Baseline normalization
// ---------------------------------------------------------------------------

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function normalizeJournal(entries) {
  return entries
    .filter(e => e && e.kind !== 'heartbeat')
    .map(e => {
      const out = { ...e };
      out.at = '<at>';
      delete out.seq;
      out.detail = normalizeDetail(e.detail);
      return out;
    });
}

function normalizeDetail(detail) {
  const out = {};
  for (const [k, v] of Object.entries(detail || {})) {
    if (typeof v === 'string' && ISO_RE.test(v)) out[k] = '<time>';
    else if (k === 'worker_pid' || k === 'backend_pid') out[k] = '<pid>';
    else if (k === 'worker_identity') out[k] = '<identity>';
    else if (k === 'execution_token') out[k] = '<token>';
    else if (k === 'job_id' || k === 'root_job_id') out[k] = '<job-id>';
    else if (k === 'repo_key') out[k] = '<repo-key>';
    else if (k === 'repo_root') out[k] = '<repo-root>';
    else out[k] = v;
  }
  return out;
}

// Recursively sort object keys so comparison is key-order independent but
// byte-stable, so `JSON.stringify` equality is a real byte comparison.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

function terminalEntry(journal, state) {
  const entries = [...journal].reverse();
  return entries.find(e => e.kind === 'attempt_state_changed' && e.to === state);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  // =========================================================================
  // 1. Characterization baseline — foreground and worker journal identically
  // =========================================================================
  {
    const dir = tmpDir('dcli-driver-baseline-');
    let child = null;
    try {
      const store = new JobStore({ stateRoot: dir });

      // Foreground path: executeRun end to end.
      const fg = await executeRun({
        store, adapter: new FakeAdapter(BASELINE_SCRIPT),
        repoKey: 'baseline-fg', repoRoot: dir, prompt: 'baseline',
        hardTimeoutSec: 60,
      });
      assert.strictEqual(fg.exitCode, 0, 'foreground run must exit 0');
      const fgJournal = normalizeJournal(store.readJournal({ repoKey: 'baseline-fg', jobId: fg.jobId }));

      // Worker path: a real detached worker driving the same script.
      const wkRepo = 'baseline-wk';
      const wkJob = 'baseline-wk';
      const wkStore = new JobStore({ stateRoot: dir });
      wkStore.createJob({
        jobId: wkJob, repoKey: wkRepo, repoRoot: dir,
        backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
        mode: 'run', access: 'read-only', hardTimeoutSec: 60,
        capabilitiesSnapshot: CAPABILITIES,
      });
      const wkJobDir = wkStore.getJobDir(wkRepo, wkJob);
      fs.mkdirSync(path.join(wkJobDir, 'attempts', '1'), { recursive: true });
      fs.writeFileSync(path.join(wkJobDir, 'prompt.txt'), 'baseline', 'utf8');
      fs.writeFileSync(path.join(wkJobDir, 'params.json'), JSON.stringify({
        canonicalDir: dir, model: null, access: 'read-only',
        reasoningEffort: null, variant: null, effort: null,
        mode: 'run', hardTimeoutMs: 60000,
        executionToken: 'tok-worker',
        _adapterScript: BASELINE_SCRIPT,
      }), 'utf8');

      child = spawn(process.execPath, [WORKER], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DCLI_WORKER: '1', DCLI_STATE_ROOT: dir,
          DCLI_BACKEND: 'fake', DCLI_JOB_ID: wkJob,
          DCLI_REPO_KEY: wkRepo, DCLI_REPO_ROOT: dir,
          DCLI_WORKER_HARD_TIMEOUT_MS: '60000',
        },
      });
      let wkErr = '';
      child.stderr.on('data', c => { wkErr += c.toString(); });
      const deadline = Date.now() + 30000;
      let wkStatus;
      do {
        await sleep(150);
        try { wkStatus = wkStore.readStatus({ repoKey: wkRepo, jobId: wkJob }); } catch {}
      } while ((!wkStatus || wkStatus.state === 'created' || wkStatus.state === 'running') && Date.now() < deadline);
      assert.ok(wkStatus && wkStatus.state === 'done',
        `worker baseline must finish done, got ${wkStatus && wkStatus.state}: ${wkErr}`);
      const wkJournal = normalizeJournal(wkStore.readJournal({ repoKey: wkRepo, jobId: wkJob }));

      // The two paths journal identically for an ordinary successful run.
      assert.deepStrictEqual(canonical(fgJournal), canonical(wkJournal),
        'foreground and worker journals must be byte-identical (normalized) for a clean run');

      // And the recorded baseline must not drift across the merge.
      const serialized = JSON.stringify(canonical(fgJournal), null, 2) + '\n';
      if (!fs.existsSync(FIXTURE)) {
        fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
        fs.writeFileSync(FIXTURE, serialized, 'utf8');
        console.log('PASS: baseline recorded (new fixture written)');
      } else {
        assert.strictEqual(
          fs.readFileSync(FIXTURE, 'utf8'), serialized,
          'the attempt-driver baseline drifted from the recorded fixture'
        );
        console.log('PASS: characterization baseline — foreground == worker, fixture intact');
      }
    } finally {
      await killAndVerify(child);
      clean(dir);
    }
  }

  // =========================================================================
  // Criterion C — a foreground run responds to dcli cancel.
  // =========================================================================
  {
    const dir = tmpDir('dcli-driver-cancel-');
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'fg-cancel';
      const jobDir = store.getJobDir('fg-cancel', jobId);
      seedJob(store, 'fg-cancel', jobId, dir);

      const cancelSignal = fileCancelSignal(jobDir);
      const adapter = new FakeAdapter({
        facts: [
          { type: 'started', backend_pid: 99999 },
          { type: 'assistant_text', message_id: 'm1', text: 'partial' },
        ],
        exitCode: 0, declaredRungs: ['hard_kill'],
        capabilities: CAPABILITIES,
        behaviors: { hangAfter: 'assistant_text' },
      });

      const runPromise = (() => {
        const { driveAttempt } = require(path.join(ROOT, 'core', 'commands', 'attempt-driver'));
        return driveAttempt({
          store, adapter, repoKey: 'fg-cancel', repoRoot: dir, jobId, attemptNum: 1,
          prompt: 'x', request: REQUEST, hardTimeoutSec: 60,
          cancelSignal,
        });
      })();

      await sleep(600);
      fs.writeFileSync(path.join(jobDir, 'cancel.request'), JSON.stringify({
        requested_at: new Date().toISOString(), job_id: jobId,
      }), 'utf8');

      const result = await runPromise;
      assert.strictEqual(result.terminalState, 'cancelled',
        'a cancel.request must take the foreground job to cancelled');
      assert.strictEqual(result.exitCode, 0);
      const status = store.readStatus({ repoKey: 'fg-cancel', jobId });
      assert.strictEqual(status.state, 'cancelled', 'the journaled state must be cancelled');
      console.log('PASS: criterion C — foreground driveAttempt reaches cancelled on cancel.request');
    } finally {
      clean(dir);
    }
  }

  // =========================================================================
  // Criterion D — a foreground hard timeout records kill_skipped.
  // =========================================================================
  {
    const dir = tmpDir('dcli-driver-timeout-');
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'fg-timeout';
      seedJob(store, 'fg-timeout', jobId, dir, { hardTimeoutSec: 1 });

      const adapter = new FakeAdapter({
        facts: [
          { type: 'started', backend_pid: 99999 },
          { type: 'assistant_text', message_id: 'm1', text: 'partial' },
        ],
        exitCode: 0, declaredRungs: ['hard_kill'],
        capabilities: CAPABILITIES,
        behaviors: { hangAfter: 'assistant_text' },
      });

      const { driveAttempt } = require(path.join(ROOT, 'core', 'commands', 'attempt-driver'));
      const result = await driveAttempt({
        store, adapter, repoKey: 'fg-timeout', repoRoot: dir, jobId, attemptNum: 1,
        prompt: 'x', request: REQUEST, hardTimeoutSec: 1,
      });

      assert.strictEqual(result.terminalState, 'timed_out');
      assert.strictEqual(result.exitCode, 24);
      const terminal = terminalEntry(store.readJournal({ repoKey: 'fg-timeout', jobId }), 'timed_out');
      assert.ok(terminal, 'timed_out terminal entry must exist');
      assert.strictEqual(terminal.detail.kill_skipped, 'not_contained',
        'a foreground hard timeout must record kill_skipped: not_contained, same as the worker');
      assert.strictEqual(terminal.detail.failure_reason, 'hard_timeout');
      console.log('PASS: criterion D — foreground hard timeout records kill_skipped');
    } finally {
      clean(dir);
    }
  }

  // =========================================================================
  // Criterion E — a worktree-backed attempt records the result commit.
  // =========================================================================
  {
    const dir = tmpDir('dcli-driver-worktree-');
    try {
      const repoRoot = path.join(dir, 'repo');
      initRepo(repoRoot);
      const stateRoot = path.join(dir, 'state');
      const store = new JobStore({ stateRoot });
      const jobId = 'worktree-job';
      seedJob(store, 'worktree-job', jobId, repoRoot);

      const worktreePath = path.join(stateRoot, 'worktrees', jobId);
      const wt = createDetachedWorktree(repoRoot, worktreePath, undefined, stateRoot);

      const adapter = new FakeAdapter(BASELINE_SCRIPT);
      const { driveAttempt } = require(path.join(ROOT, 'core', 'commands', 'attempt-driver'));
      const result = await driveAttempt({
        store, adapter, repoKey: 'worktree-job', repoRoot, jobId, attemptNum: 1,
        prompt: 'implement x', request: { ...REQUEST, canonicalDir: worktreePath },
        worktreePath, worktreeBaseCommit: wt.baseCommit,
        hardTimeoutSec: 60,
      });

      assert.strictEqual(result.terminalState, 'done');
      const terminal = terminalEntry(store.readJournal({ repoKey: 'worktree-job', jobId }), 'done');
      assert.ok(terminal, 'done terminal entry must exist');
      assert.ok(terminal.detail.worktree_result_commit,
        `worktree_result_commit must be recorded in the terminal detail, got ${JSON.stringify(terminal.detail)}`);
      assert.ok(/^[0-9a-f]{40}$/.test(terminal.detail.worktree_result_commit),
        'worktree_result_commit must be a commit hash');
      console.log('PASS: criterion E — worktree result commit recorded in terminal detail');
    } finally {
      clean(dir);
    }
  }

  // =========================================================================
  // Criterion F — fallbackSessionId when the backend reports no session id.
  // =========================================================================
  {
    const dir = tmpDir('dcli-driver-fallback-');
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'fallback-job';
      seedJob(store, 'fallback-job', jobId, dir);

      const adapter = new FakeAdapter({
        facts: [
          { type: 'started', backend_pid: 99999 },
          { type: 'assistant_text', message_id: 'm1', text: 'no session reported' },
          { type: 'process_exited', code: 0 },
        ],
        exitCode: 0, declaredRungs: ['hard_kill'],
        capabilities: CAPABILITIES,
      });

      const { driveAttempt } = require(path.join(ROOT, 'core', 'commands', 'attempt-driver'));
      const result = await driveAttempt({
        store, adapter, repoKey: 'fallback-job', repoRoot: dir, jobId, attemptNum: 1,
        prompt: 'x', request: REQUEST, hardTimeoutSec: 60,
        fallbackSessionId: 'ses_fallback',
      });

      assert.strictEqual(result.terminalState, 'done');
      const terminal = terminalEntry(store.readJournal({ repoKey: 'fallback-job', jobId }), 'done');
      assert.strictEqual(terminal.detail.backend_session_id, 'ses_fallback',
        'a backend that reports no session id must fall back to the recorded fallbackSessionId');
      console.log('PASS: criterion F — fallbackSessionId recorded when the backend reports none');
    } finally {
      clean(dir);
    }
  }

  // =========================================================================
  // Criterion G — driveAttempt in-process, no detached processes:
  // cancellation, hard timeout, result-persistence failure.
  // =========================================================================
  {
    const dir = tmpDir('dcli-driver-g-cancel-');
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'g-cancel';
      seedJob(store, 'g-cancel', jobId, dir);
      const signal = manualSignal();
      const adapter = new FakeAdapter({
        facts: [
          { type: 'started', backend_pid: 99999 },
          { type: 'assistant_text', message_id: 'm1', text: 'partial' },
        ],
        exitCode: 0, declaredRungs: ['hard_kill'],
        capabilities: CAPABILITIES,
        behaviors: { hangAfter: 'assistant_text' },
      });

      const { driveAttempt } = require(path.join(ROOT, 'core', 'commands', 'attempt-driver'));
      const runPromise = driveAttempt({
        store, adapter, repoKey: 'g-cancel', repoRoot: dir, jobId, attemptNum: 1,
        prompt: 'x', request: REQUEST, hardTimeoutSec: 60,
        cancelSignal: signal,
      });
      setTimeout(() => signal.cancel(), 500);
      const result = await runPromise;
      assert.strictEqual(result.terminalState, 'cancelled');
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(store.readStatus({ repoKey: 'g-cancel', jobId }).state, 'cancelled');
      console.log('PASS: criterion G — in-process cancellation via injected cancelSignal');
    } finally {
      clean(dir);
    }
  }

  {
    const dir = tmpDir('dcli-driver-g-timeout-');
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'g-timeout';
      seedJob(store, 'g-timeout', jobId, dir, { hardTimeoutSec: 1 });
      const adapter = new FakeAdapter({
        facts: [
          { type: 'started', backend_pid: 99999 },
          { type: 'assistant_text', message_id: 'm1', text: 'partial' },
        ],
        exitCode: 0, declaredRungs: ['hard_kill'],
        capabilities: CAPABILITIES,
        behaviors: { hangAfter: 'assistant_text' },
      });

      const { driveAttempt } = require(path.join(ROOT, 'core', 'commands', 'attempt-driver'));
      const result = await driveAttempt({
        store, adapter, repoKey: 'g-timeout', repoRoot: dir, jobId, attemptNum: 1,
        prompt: 'x', request: REQUEST, hardTimeoutSec: 1,
      });
      assert.strictEqual(result.terminalState, 'timed_out');
      assert.strictEqual(result.exitCode, 24);
      const terminal = terminalEntry(store.readJournal({ repoKey: 'g-timeout', jobId }), 'timed_out');
      assert.strictEqual(terminal.detail.kill_skipped, 'not_contained');
      console.log('PASS: criterion G — in-process hard timeout');
    } finally {
      clean(dir);
    }
  }

  {
    const dir = tmpDir('dcli-driver-g-persist-');
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'g-persist';
      const attemptDir = path.join(store.getJobDir('g-persist', jobId), 'attempts', '1');
      seedJob(store, 'g-persist', jobId, dir);

      const adapter = new FakeAdapter({
        facts: [
          { type: 'started', backend_pid: 99999 },
          { type: 'assistant_text', message_id: 'm1', text: 'will vanish' },
          { type: 'process_exited', code: 0 },
        ],
        exitCode: 0, declaredRungs: ['hard_kill'],
        capabilities: CAPABILITIES,
      });
      const collect = adapter.CollectResult.bind(adapter);
      adapter.CollectResult = (attempt) => {
        const result = collect(attempt);
        fs.rmSync(attemptDir, { recursive: true, force: true });
        return result;
      };

      const { driveAttempt } = require(path.join(ROOT, 'core', 'commands', 'attempt-driver'));
      const result = await driveAttempt({
        store, adapter, repoKey: 'g-persist', repoRoot: dir, jobId, attemptNum: 1,
        prompt: 'x', request: REQUEST, hardTimeoutSec: 60,
      });
      assert.strictEqual(result.exitCode, 11);
      assert.strictEqual(result.terminalState, 'failed');
      const terminal = terminalEntry(store.readJournal({ repoKey: 'g-persist', jobId }), 'failed');
      assert.strictEqual(terminal.detail.failure_reason, 'result_persistence_failed');
      console.log('PASS: criterion G — in-process result-persistence failure');
    } finally {
      clean(dir);
    }
  }

  console.log('\nAll attempt-driver tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.stack || err.message);
  process.exit(1);
});
