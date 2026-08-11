// @suite full
// @serial  spawns a real worker for the redactor-initialization wiring
//
// Ticket 114 — the detached worker is a fresh Node process that never
// received the parent CLI's redactor initialization, so getRedactor() was
// null in it and the opencode server's per-job password registration was a
// silent no-op: writer-path redaction did not hold on the submit path.
// This test proves the wiring end to end: a planted token is registered
// through getRedactor() inside the real worker process (the fake adapter
// stands in for the opencode server's password registration) and every
// writer path that receives the token — prompt.md, command.json,
// journal.jsonl, result.md — is redacted on disk.
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const { JobStore } = require('../../core/job-store');

const REPO_KEY = 'test';
const WORKER = path.resolve(__dirname, '..', '..', 'core', 'commands', 'worker.js');
const PLANTED = 'sk-planted-114-redactor-token-0123456789';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-worker-redactor-'));
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function seedJob(dir, jobId) {
  const store = new JobStore({ stateRoot: dir });
  store.createJob({
    jobId, repoKey: REPO_KEY, repoRoot: process.cwd(),
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'submit', access: 'read-only',
  });
  const jobDir = store.getJobDir(REPO_KEY, jobId);
  fs.writeFileSync(path.join(jobDir, 'prompt.txt'), `run a task with ${PLANTED}\n`, 'utf8');
  fs.writeFileSync(path.join(jobDir, 'params.json'), JSON.stringify({
    executionToken: PLANTED,
    model: PLANTED,
    mode: 'run',
    access: 'read-only',
    _adapterScript: {
      // Mirrors the opencode server registering its generated per-job password
      // through getRedactor() on start (adapters/opencode/server.js).
      redactorSecrets: { planted: PLANTED },
      facts: [
        { type: 'started', backend_pid: 1, backend_session_id: 'ses_redactor' },
        { type: 'assistant_text', message_id: 'm1', text: `finished ${PLANTED}` },
        { type: 'usage_reported', tokens: { input: 1, output: 1, total: 2 } },
        { type: 'process_exited', code: 0 },
      ],
    },
  }), 'utf8');
  return { store, jobDir };
}

function runWorker(dir, jobId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        DCLI_WORKER: '1',
        DCLI_STATE_ROOT: dir,
        DCLI_BACKEND: 'fake',
        DCLI_JOB_ID: jobId,
        DCLI_REPO_KEY: REPO_KEY,
        DCLI_REPO_ROOT: process.cwd(),
        DCLI_WORKER_HARD_TIMEOUT_MS: '60000',
      },
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('worker did not exit within 30s'));
    }, 30000);
    child.once('close', (code) => { clearTimeout(timer); resolve(code); });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function grepDir(dirPath, pattern) {
  const hits = [];
  // The two seed files are written by the test process itself (nothing has
  // registered the token there) — everything else on disk is worker-written.
  const excluded = new Set(['params.json', 'prompt.txt']);
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.isFile() && !excluded.has(entry.name)) {
        const content = fs.readFileSync(full, 'utf8');
        if (content.includes(pattern)) hits.push(full);
      }
    }
  }
  walk(dirPath);
  return hits;
}

async function main() {
  const dir = tmpDir();
  try {
    const { store, jobDir } = seedJob(dir, 'redactor-1');
    const exitCode = await runWorker(dir, 'redactor-1');
    assert.strictEqual(exitCode, 0, 'worker must complete the fake run');

    const status = store.readStatus({ repoKey: REPO_KEY, jobId: 'redactor-1' });
    assert.strictEqual(status.state, 'done', 'worker must finish done');

    // The raw planted token must not appear anywhere the worker wrote.
    const matches = grepDir(jobDir, PLANTED);
    assert.strictEqual(matches.length, 0,
      `Planted token found in ${matches.length} worker-written file(s): ${matches.join(', ')}`);

    // Every writer path that received the token must carry the placeholder.
    const attemptDir = path.join(jobDir, 'attempts', '1');
    const placeholder = '\u00abredacted:planted\u00bb';
    const promptMd = fs.readFileSync(path.join(attemptDir, 'prompt.md'), 'utf8');
    assert.ok(promptMd.includes(placeholder), 'prompt.md (writeTextFileAtomic) must be redacted');
    const commandJson = fs.readFileSync(path.join(attemptDir, 'command.json'), 'utf8');
    assert.ok(commandJson.includes(placeholder), 'command.json (writeJsonFileAtomic) must be redacted');
    const journal = fs.readFileSync(path.join(jobDir, 'journal.jsonl'), 'utf8');
    assert.ok(journal.includes(placeholder), 'journal.jsonl (appendJsonLine) must be redacted');
    const resultMd = fs.readFileSync(path.join(attemptDir, 'result.md'), 'utf8');
    assert.ok(resultMd.includes(placeholder), 'result.md (writeTextFileAtomic) must be redacted');

    console.log('PASS: worker-initialized redactor redacts every writer path');
  } finally {
    clean(dir);
  }
  console.log('\nAll worker redactor tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
