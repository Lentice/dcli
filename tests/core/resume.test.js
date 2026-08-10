// @suite full
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { FakeAdapter } = require('../../adapters/fake/adapter');
const { executeResume, VALID_KINDS } = require('../../core/commands/resume');
const { JobStore } = require('../../core/job-store');
const { generateJobId } = require('../../core/job-id');

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-test-resume-'));
  const stateRoot = path.join(tmpDir, 'state');
  fs.mkdirSync(stateRoot, { recursive: true });
  const store = new JobStore({ stateRoot });
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 100, backend_session_id: 'ses_parent' },
      { type: 'assistant_text', message_id: 'msg_1', text: 'Parent result.' },
      { type: 'usage_reported', tokens: { input: 50, output: 100, total: 150 } },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: {
      schema_version: 1, backend: 'fake', core: { run: true, submit: true, resume: true },
    },
  });
  return { tmpDir, stateRoot, store, adapter };
}

function teardown() {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function createParentJob(store, repoKey, repoRoot, overrides = {}) {
  const jobId = generateJobId();
  store.createJob({
    jobId,
    repoKey,
    repoRoot,
    backend: 'test',
    backendVersion: '1.0.0',
    adapterVersion: '1.0.0',
    mode: overrides.mode || 'run',
    access: 'read-only',
    hardTimeoutSec: 600,
    capabilitiesSnapshot: {},
    ...overrides,
  });

  const attemptNum = 1;
  store.createAttemptDir({ repoKey, jobId, attemptNum });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created',
    attempt: attemptNum,
    from: null,
    to: 'created',
    detail: { attempt_id: `attempt-${attemptNum}`, execution_token: 'tok-parent' },
  });

  const sessionId = 'sessionId' in overrides ? overrides.sessionId : 'ses_parent';
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed',
    attempt: attemptNum,
    from: 'created',
    to: 'done',
    detail: {
      finished_at: new Date().toISOString(),
      command_exit_code: 0,
      phase: 'terminal',
      ...(sessionId !== undefined && sessionId !== null ? { backend_session_id: sessionId } : {}),
    },
  });
  return jobId;
}

async function main() {
  // ---------------------------------------------------------------------------
  // 1. VALID_KINDS is correctly defined
  // ---------------------------------------------------------------------------
  {
    assert.ok(VALID_KINDS);
    assert.ok(VALID_KINDS.has('continue_backend_session'));
    assert.ok(VALID_KINDS.has('fork_from_artifacts'));
    assert.ok(VALID_KINDS.has('retry_attempt'));
    assert.strictEqual(VALID_KINDS.size, 3);
  }

  // ---------------------------------------------------------------------------
  // 2. resume requires --kind
  // ---------------------------------------------------------------------------
  {
    const { store, stateRoot, adapter } = setup();
    const repoKey = 'test';
    const repoRoot = tmpDir;
    const parentJobId = createParentJob(store, repoKey, repoRoot);

    try {
      await executeResume({
        store, adapter, repoKey, repoRoot,
        prompt: 'continue',
        kind: null,
        parentJobId,
        stateRoot,
      });
      assert.fail('Should have thrown for missing --kind');
    } catch (err) {
      assert.strictEqual(err.exitCode, 2);
      assert.ok(err.message.includes('--kind'));
    }

    teardown();
  }

  // ---------------------------------------------------------------------------
  // 3. resume requires a parent job id
  // ---------------------------------------------------------------------------
  {
    const { store, stateRoot, adapter } = setup();
    const repoKey = 'test';
    const repoRoot = tmpDir;

    try {
      await executeResume({
        store, adapter, repoKey, repoRoot,
        prompt: 'continue',
        kind: 'fork_from_artifacts',
        parentJobId: null,
        stateRoot,
      });
      assert.fail('Should have thrown for missing parent job id');
    } catch (err) {
      assert.strictEqual(err.exitCode, 2);
      assert.ok(err.message.includes('parent job ID'));
    }

    teardown();
  }

  // ---------------------------------------------------------------------------
  // 4. resume with non-existent parent job exits 3
  // ---------------------------------------------------------------------------
  {
    const { store, stateRoot, adapter } = setup();
    const repoKey = 'test';
    const repoRoot = tmpDir;

    try {
      await executeResume({
        store, adapter, repoKey, repoRoot,
        prompt: 'continue',
        kind: 'fork_from_artifacts',
        parentJobId: 'nonexistent-job',
        stateRoot,
      });
      assert.fail('Should have thrown for non-existent parent');
    } catch (err) {
      assert.strictEqual(err.exitCode, 3);
    }

    teardown();
  }

  // ---------------------------------------------------------------------------
  // 5. continue_backend_session with no backend session id exits 22
  // ---------------------------------------------------------------------------
  {
    const { store, stateRoot, adapter } = setup();
    const repoKey = 'test';
    const repoRoot = tmpDir;
    const parentJobId = createParentJob(store, repoKey, repoRoot, { sessionId: null });

    try {
      await executeResume({
        store, adapter, repoKey, repoRoot,
        prompt: 'continue',
        kind: 'continue_backend_session',
        parentJobId,
        stateRoot,
      });
      assert.fail('Should have thrown for missing backend session');
    } catch (err) {
      assert.strictEqual(err.exitCode, 22);
      assert.ok(err.message.includes('no backend session id'));
    }

    teardown();
  }

  // ---------------------------------------------------------------------------
  // 6. continue_backend_session with backend that cannot resume exits 22
  // ---------------------------------------------------------------------------
  {
    const { store, stateRoot } = setup();
    const repoKey = 'test';
    const repoRoot = tmpDir;
    const parentJobId = createParentJob(store, repoKey, repoRoot);

    const noResumeAdapter = new FakeAdapter({
      facts: [
        { type: 'started', backend_pid: 200, backend_session_id: 'ses_noresume' },
        { type: 'process_exited', code: 0 },
      ],
      exitCode: 0,
      declaredRungs: ['hard_kill'],
      capabilities: {
        schema_version: 1, backend: 'fake', core: { run: true, submit: true, resume: false },
      },
    });

    try {
      await executeResume({
        store, adapter: noResumeAdapter, repoKey, repoRoot,
        prompt: 'continue',
        kind: 'continue_backend_session',
        parentJobId,
        stateRoot,
      });
      assert.fail('Should have thrown for backend without resume capability');
    } catch (err) {
      assert.strictEqual(err.exitCode, 22);
      assert.ok(err.message.includes('does not support'));
    }

    teardown();
  }

  // ---------------------------------------------------------------------------
  // 7. resume creates a new job with correct lineage
  // ---------------------------------------------------------------------------
  {
    const { store, stateRoot, adapter } = setup();
    try {
      const repoKey = 'test';
      const repoRoot = tmpDir;

      const rootJobId = createParentJob(store, repoKey, repoRoot);
      const parentJobId = createParentJob(store, repoKey, repoRoot, {
        mode: 'run',
        access: 'read-only',
        parentJobId: rootJobId,
        rootJobId: rootJobId,
      });

      const result = await executeResume({
        store, adapter, repoKey, repoRoot,
        prompt: 'continue as fork',
        kind: 'fork_from_artifacts',
        parentJobId,
        stateRoot,
      });

      assert.ok(result.jobId);
      assert.ok(result.jobId !== parentJobId);
      assert.ok(result.jobId !== rootJobId);

      const childStatus = store.readStatus({ repoKey, jobId: result.jobId });
      assert.strictEqual(childStatus.parent_job_id, parentJobId);
      assert.strictEqual(childStatus.root_job_id, rootJobId);
      assert.strictEqual(childStatus.session_strategy, 'fork_from_artifacts');
      const resultPath = path.join(store.getJobDir(repoKey, result.jobId), 'attempts', '1', 'result.md');
      const persisted = fs.readFileSync(resultPath, 'utf8');
      assert.strictEqual(persisted, 'Parent result.');
      assert.strictEqual(childStatus.result_bytes, Buffer.byteLength(persisted, 'utf8'));
    } finally {
      teardown();
    }
  }

  // ---------------------------------------------------------------------------
  // 8. resume with retry_attempt creates new job with lineage
  // ---------------------------------------------------------------------------
  {
    const { store, stateRoot, adapter } = setup();
    try {
      const repoKey = 'test';
      const repoRoot = tmpDir;

      const parentJobId = createParentJob(store, repoKey, repoRoot);

      const result = await executeResume({
        store, adapter, repoKey, repoRoot,
        prompt: 'retry',
        kind: 'retry_attempt',
        parentJobId,
        stateRoot,
      });

      assert.ok(result.jobId);
      const childStatus = store.readStatus({ repoKey, jobId: result.jobId });
      assert.strictEqual(childStatus.parent_job_id, parentJobId);
      assert.strictEqual(childStatus.session_strategy, 'retry_attempt');
    } finally {
      teardown();
    }
  }

  // ---------------------------------------------------------------------------
  // 9. Stray positionals handling
  // ---------------------------------------------------------------------------
  {
    const { parseArgs } = require('../../core/cli-args');
    const parsed = parseArgs(['node', 'test', 'resume', '20260804T123456Z-a1b2c3d4', 'extra-positional']);
    assert.strictEqual(parsed.command, 'resume');
    assert.ok(parsed.positionals.length > 0);
  }

  // ---------------------------------------------------------------------------
  // 10. Lineage fallback: resumed run with no session identity falls back
  //     to parent's recorded id
  // ---------------------------------------------------------------------------
  {
    const { store, stateRoot } = setup();
    try {
      const repoKey = 'test';
      const repoRoot = tmpDir;

      const parentJobId = createParentJob(store, repoKey, repoRoot, { sessionId: 'ses_parent_original' });

      const noSessionAdapter = new FakeAdapter({
        facts: [
          { type: 'started', backend_pid: 300, backend_session_id: null },
          { type: 'assistant_text', message_id: 'msg_1', text: 'Resumed result.' },
          { type: 'usage_reported', tokens: { input: 10, output: 20, total: 30 } },
          { type: 'process_exited', code: 0 },
        ],
        exitCode: 0,
        declaredRungs: ['hard_kill'],
        capabilities: {
          schema_version: 1, backend: 'fake', core: { run: true, resume: true },
        },
      });

      const result = await executeResume({
        store, adapter: noSessionAdapter, repoKey, repoRoot,
        prompt: 'continue',
        kind: 'continue_backend_session',
        parentJobId,
        stateRoot,
      });

      const childStatus = store.readStatus({ repoKey, jobId: result.jobId });
      assert.strictEqual(childStatus.backend_session_id, 'ses_parent_original');
    } finally {
      teardown();
    }
  }

  // ---------------------------------------------------------------------------
  // 11. status surfaces lineage chain
  // ---------------------------------------------------------------------------
  {
    const { store, stateRoot, adapter } = setup();
    try {
      const repoKey = 'test';
      const repoRoot = tmpDir;

      const rootId = createParentJob(store, repoKey, repoRoot);
      const parentId = createParentJob(store, repoKey, repoRoot, { parentJobId: rootId, rootJobId: rootId });

      const result = await executeResume({
        store, adapter, repoKey, repoRoot,
        prompt: 'third',
        kind: 'fork_from_artifacts',
        parentJobId: parentId,
        stateRoot,
      });

      const childStatus = store.readStatus({ repoKey, jobId: result.jobId });
      assert.strictEqual(childStatus.parent_job_id, parentId);
      assert.strictEqual(childStatus.root_job_id, rootId);

      const parentStatus = store.readStatus({ repoKey, jobId: parentId });
      assert.strictEqual(parentStatus.parent_job_id, rootId);
      assert.strictEqual(parentStatus.root_job_id, rootId);
    } finally {
      teardown();
    }
  }

  // ---------------------------------------------------------------------------
  // 12. Adapter Resume method is called for continue_backend_session
  // ---------------------------------------------------------------------------
  {
    const { store, stateRoot } = setup();
    try {
      const repoKey = 'test';
      const repoRoot = tmpDir;

      let resumeCalled = false;
      let resumeKind = null;
      let resumePrompt = null;

      const trackingAdapter = new FakeAdapter({
        facts: [
          { type: 'started', backend_pid: 400, backend_session_id: 'ses_track' },
          { type: 'assistant_text', message_id: 'msg_1', text: 'Resumed with tracking.' },
          { type: 'process_exited', code: 0 },
        ],
        exitCode: 0,
        declaredRungs: ['hard_kill'],
        capabilities: {
          schema_version: 1, backend: 'fake', core: { run: true, resume: true },
        },
      });

      const originalResume = trackingAdapter.Resume.bind(trackingAdapter);
      trackingAdapter.Resume = function(attempt, kind, prompt) {
        resumeCalled = true;
        resumeKind = kind;
        resumePrompt = prompt;
        originalResume(attempt, kind, prompt);
      };

      const parentJobId = createParentJob(store, repoKey, repoRoot);

      await executeResume({
        store, adapter: trackingAdapter, repoKey, repoRoot,
        prompt: 'continue here',
        kind: 'continue_backend_session',
        parentJobId,
        stateRoot,
      });

      assert.ok(resumeCalled, 'Resume method should be called for continue_backend_session');
      assert.strictEqual(resumeKind, 'continue_backend_session');
      assert.strictEqual(resumePrompt, 'continue here');
    } finally {
      teardown();
    }
  }

  // ---------------------------------------------------------------------------
  // 13. interrupted attempt supports retry_attempt and fork_from_artifacts
  //     but not continue_backend_session
  // ---------------------------------------------------------------------------
  {
    const { store } = setup();
    const repoKey = 'test';
    const repoRoot = tmpDir;

    const jobId = generateJobId();
    store.createJob({
      jobId, repoKey, repoRoot,
      backend: 'test',
      backendVersion: '1.0.0',
      adapterVersion: '1.0.0',
      mode: 'run',
      access: 'read-only',
      hardTimeoutSec: 600,
      capabilitiesSnapshot: {},
    });
    const attemptNum = 1;
    store.createAttemptDir({ repoKey, jobId, attemptNum });
    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_created', attempt: attemptNum, from: null, to: 'created',
      detail: { attempt_id: `attempt-${attemptNum}`, execution_token: 'tok-interrupted' },
    });
    store.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed', attempt: attemptNum, from: 'created', to: 'interrupted',
      detail: { finished_at: new Date().toISOString(), command_exit_code: null, phase: 'terminal' },
    });

    const { stateRoot, adapter } = setup();

    // continue_backend_session should fail
    try {
      await executeResume({
        store, adapter, repoKey, repoRoot,
        prompt: 'should fail',
        kind: 'continue_backend_session',
        parentJobId: jobId,
        stateRoot,
      });
      assert.fail('Should have thrown for interrupted parent with continue_backend_session');
    } catch (err) {
      assert.strictEqual(err.exitCode, 22);
      assert.ok(err.message.includes('interrupted'));
    }

    // retry_attempt should work
    const retryResult = await executeResume({
      store, adapter, repoKey, repoRoot,
      prompt: 'retry from interrupted',
      kind: 'retry_attempt',
      parentJobId: jobId,
      stateRoot,
    });
    assert.ok(retryResult.jobId);
    const retryStatus = store.readStatus({ repoKey, jobId: retryResult.jobId });
    assert.strictEqual(retryStatus.parent_job_id, jobId);
    assert.strictEqual(retryStatus.session_strategy, 'retry_attempt');

    // fork_from_artifacts should also work
    const forkResult = await executeResume({
      store, adapter, repoKey, repoRoot,
      prompt: 'fork from interrupted',
      kind: 'fork_from_artifacts',
      parentJobId: jobId,
      stateRoot,
    });
    assert.ok(forkResult.jobId);
    const forkStatus = store.readStatus({ repoKey, jobId: forkResult.jobId });
    assert.strictEqual(forkStatus.parent_job_id, jobId);
    assert.strictEqual(forkStatus.session_strategy, 'fork_from_artifacts');

    teardown();
  }

  console.log('All resume tests passed.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
