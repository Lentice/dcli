// Ticket 103, criterion G. A hard timeout whose rung walk ran a taskkill-tree
// termination records the survivors on the `timed_out` detail instead of
// writing `kill_skipped: 'not_contained'` — `kill_skipped` is only correct
// when no kill was attempted, and once one was, writing it is a second,
// different lie. The tree-kill result is injected via the FakeAdapter, so this
// runs on every platform (the platform itself is exercised by the adapters'
// Windows test).
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const { JobStore } = require(path.join(ROOT, 'core', 'job-store'));
const { FakeAdapter } = require(path.join(ROOT, 'adapters', 'fake', 'adapter'));

const CAPABILITIES = {
  schema_version: 1,
  backend: 'fake',
  backend_version: '1.0.0',
  core: { run: true, submit: true },
  extensions: {},
};

const REQUEST = {
  model: null,
  canonicalDir: process.cwd(),
  reasoningEffort: null,
  variant: null,
  effort: null,
  access: 'read-only',
};

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function seedJob(store, repoKey, jobId, repoRoot, { hardTimeoutSec = 60 } = {}) {
  store.createJob({
    jobId, repoKey, repoRoot,
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
    hardTimeoutSec,
    capabilitiesSnapshot: CAPABILITIES,
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

function terminalEntry(journal, state) {
  const entries = journal.filter(e => e.kind === 'attempt_state_changed' && e.to === state);
  return entries[entries.length - 1] || null;
}

async function main() {

  // =========================================================================
  // A hard timeout whose rung ran a taskkill-tree with survivors: the
  // `timed_out` detail records containment + survivors and writes NO
  // kill_skipped.
  // =========================================================================
  {
    const dir = tmpDir('dcli-ht-treekill-');
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'ht-survivors';
      seedJob(store, 'ht-survivors', jobId, dir, { hardTimeoutSec: 1 });

      const adapter = new FakeAdapter({
        facts: [
          { type: 'started', backend_pid: 99999 },
          { type: 'assistant_text', message_id: 'm1', text: 'partial' },
        ],
        exitCode: 0, declaredRungs: ['hard_kill'],
        capabilities: CAPABILITIES,
        behaviors: {
          hangAfter: 'assistant_text',
          termination: {
            kind: 'taskkill-tree',
            degraded: true,
            survivors: [{ pid: 4242, imagePath: 'C:\\tools\\stubborn.exe', reason: 'still_running' }],
          },
        },
      });

      const { driveAttempt } = require(path.join(ROOT, 'core', 'commands', 'attempt-driver'));
      const result = await driveAttempt({
        store, adapter, repoKey: 'ht-survivors', repoRoot: dir, jobId, attemptNum: 1,
        prompt: 'x', request: REQUEST, hardTimeoutSec: 1,
      });

      assert.strictEqual(result.terminalState, 'timed_out');
      assert.strictEqual(result.exitCode, 24);
      const terminal = terminalEntry(store.readJournal({ repoKey: 'ht-survivors', jobId }), 'timed_out');
      assert.ok(terminal, 'timed_out terminal entry must exist');
      assert.deepStrictEqual(terminal.detail.containment, { kind: 'taskkill-tree', degraded: true },
        'the timed_out detail must record the taskkill-tree containment');
      assert.deepStrictEqual(terminal.detail.containment_survivors, [
        { pid: 4242, image_path: 'C:\\tools\\stubborn.exe', reason: 'still_running' },
      ], 'the timed_out detail must record the survivor set');
      assert.strictEqual(terminal.detail.kill_skipped, undefined,
        'kill_skipped must NOT be written once a kill was attempted (criterion G)');

      const status = store.readStatus({ repoKey: 'ht-survivors', jobId });
      assert.deepStrictEqual(status.containment, { kind: 'taskkill-tree', degraded: true },
        'the containment record must project into status.json');
      assert.deepStrictEqual(status.containment_survivors, [
        { pid: 4242, image_path: 'C:\\tools\\stubborn.exe', reason: 'still_running' },
      ], 'the survivor set must project into status.json');
      assert.strictEqual(status.kill_skipped, null, 'status.json must not carry kill_skipped');

      console.log('PASS: criterion G — hard-timeout survivors recorded, kill_skipped absent');
    } finally {
      clean(dir);
    }
  }

  // =========================================================================
  // A hard timeout with no tree-kill result keeps writing kill_skipped when a
  // kill was not attempted (the pre-ticket behaviour is preserved where it is
  // still honest).
  // =========================================================================
  {
    const dir = tmpDir('dcli-ht-nokill-');
    try {
      const store = new JobStore({ stateRoot: dir });
      const jobId = 'ht-nokill';
      seedJob(store, 'ht-nokill', jobId, dir, { hardTimeoutSec: 1 });

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
        store, adapter, repoKey: 'ht-nokill', repoRoot: dir, jobId, attemptNum: 1,
        prompt: 'x', request: REQUEST, hardTimeoutSec: 1,
      });

      assert.strictEqual(result.terminalState, 'timed_out');
      const terminal = terminalEntry(store.readJournal({ repoKey: 'ht-nokill', jobId }), 'timed_out');
      assert.ok(terminal, 'timed_out terminal entry must exist');
      assert.strictEqual(terminal.detail.kill_skipped, process.platform === 'win32' ? 'not_contained' : undefined,
        'when no kill was attempted, the honest record is preserved (not_contained on Windows, absent on Unix)');
      assert.strictEqual(terminal.detail.containment, undefined,
        'no taskkill-tree ran, so no containment record is invented');

      console.log('PASS: criterion G (no attempt) — kill_skipped preserved when nothing was attempted');
    } finally {
      clean(dir);
    }
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
