const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { FakeAdapter } = require('../../adapters/fake/adapter');
const { executeRun } = require('../../core/commands/run');
const { executeResume, VALID_KINDS } = require('../../core/commands/resume');
const { JobStore } = require('../../core/job-store');
const { generateJobId } = require('../../core/job-id');
const {
  classifyTerminalFailure,
  maybeAccessHint,
  NO_RESULT_BYTE_THRESHOLD,
} = require('../../core/commands/index');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-fail-reason-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return fn(dir).then(cleanup, (err) => { cleanup(); throw err; });
}

function adapterFor(text, exitCode, extraFacts) {
  const facts = [];
  if (text !== null) facts.push({ type: 'assistant_text', message_id: 'm1', text });
  facts.push({ type: 'started', backend_session_id: 'ses-fake' });
  if (extraFacts) facts.push(...extraFacts);
  facts.push({ type: 'process_exited', code: exitCode });
  return new FakeAdapter({
    facts,
    exitCode,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true, resume: true } },
  });
}

function createDoneParent(store, repoKey, repoRoot) {
  const jobId = generateJobId();
  store.createJob({
    jobId, repoKey, repoRoot,
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only',
    hardTimeoutSec: 600, capabilitiesSnapshot: {},
  });
  store.createAttemptDir({ repoKey, jobId, attemptNum: 1 });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_created', attempt: 1, from: null, to: 'created',
    detail: { attempt_id: 'attempt-1', execution_token: 'tok-parent' },
  });
  store.journalTransition(jobId, repoKey, {
    kind: 'attempt_state_changed', attempt: 1, from: 'created', to: 'done',
    detail: { finished_at: new Date().toISOString(), command_exit_code: 0, phase: 'terminal', backend_session_id: 'ses_parent' },
  });
  return jobId;
}

async function main() {

// =============================================================================
// 1. process_exited with non-zero code AND empty result -> failure_reason
//    is 'backend_exited_no_result'; reducer's failure (process_error) is
//    observable in status. This is the observed dcli-claude silent-failure
//    shape (exit 1 + 189 bytes of boilerplate; here we test the empty case).
// =============================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const output = await executeRun({
    store, adapter: adapterFor('', 1),
    repoKey: 'fail-1', repoRoot: dir,
    prompt: 'verify everything',
    hardTimeoutSec: 60,
  });

  const status = store.readStatus({ repoKey: 'fail-1', jobId: output.jobId });
  assert.strictEqual(status.state, 'failed', `expected failed, got ${status.state}`);
  assert.strictEqual(status.command_exit_code, 1, `expected exit 1, got ${status.command_exit_code}`);
  assert.strictEqual(status.failure_reason, 'backend_exited_no_result',
    `failure_reason must be backend_exited_no_result, got ${JSON.stringify(status.failure_reason)}`);
  assert.ok(status.failure, 'failure must be observable for non-zero exit');
  assert.strictEqual(status.failure && status.failure.reason, 'process_error',
    `failure.reason must be process_error (from reducer), got ${JSON.stringify(status.failure)}`);

  console.log('PASS: empty result + exit 1 -> failure_reason=backend_exited_no_result + observable failure');
});

// =============================================================================
// 2. process_exited with non-zero code AND substantial result -> failure is
//    observable (process_error) but failure_reason is NOT the no-result class
//    (a real result was produced). The reducer's failure must propagate.
// =============================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const substantial = 'Here is the analysis.\n' + 'x'.repeat(NO_RESULT_BYTE_THRESHOLD * 2);
  const output = await executeRun({
    store, adapter: adapterFor(substantial, 1),
    repoKey: 'fail-2', repoRoot: dir,
    prompt: 'review',
    hardTimeoutSec: 60,
  });

  const status = store.readStatus({ repoKey: 'fail-2', jobId: output.jobId });
  assert.strictEqual(status.state, 'failed', `expected failed, got ${status.state}`);
  assert.strictEqual(status.command_exit_code, 1);
  assert.ok(status.failure, 'failure must be observable for non-zero exit (reducer propagation)');
  assert.strictEqual(status.failure.reason, 'process_error');
  assert.notStrictEqual(status.failure_reason, 'backend_exited_no_result',
    `substantial result must not be marked backend_exited_no_result, got ${status.failure_reason}`);

  console.log('PASS: substantial result + exit 1 -> observable failure, not no-result class');
});

// =============================================================================
// 3. process_exited with zero code -> done, no failure, no failure_reason.
//    (Protect against false positives.)
// =============================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const output = await executeRun({
    store, adapter: adapterFor('answer', 0),
    repoKey: 'fail-3', repoRoot: dir,
    prompt: 'question',
    hardTimeoutSec: 60,
  });

  const status = store.readStatus({ repoKey: 'fail-3', jobId: output.jobId });
  assert.strictEqual(status.state, 'done', `expected done, got ${status.state}`);
  assert.strictEqual(status.failure_reason, null);
  assert.strictEqual(status.failure, null);

  console.log('PASS: exit 0 -> done with no failure');
});

// =============================================================================
// 4. resume path: process_exited non-zero + empty result populates failure_reason
//    so a silent claude resume failure is observable.
// =============================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const parentId = createDoneParent(store, 'fail-4', dir);
  const adapter = adapterFor('', 1);
  const output = await executeResume({
    store, adapter, repoKey: 'fail-4', repoRoot: dir,
    prompt: 'follow up',
    kind: 'fork_from_artifacts',
    parentJobId: parentId,
    hardTimeoutSec: 60,
  });

  const status = store.readStatus({ repoKey: 'fail-4', jobId: output.jobId });
  assert.strictEqual(status.state, 'failed');
  assert.strictEqual(status.command_exit_code, 1);
  assert.strictEqual(status.failure_reason, 'backend_exited_no_result',
    `resume failure_reason must be backend_exited_no_result, got ${status.failure_reason}`);
  assert.strictEqual(status.failure && status.failure.reason, 'process_error');

  console.log('PASS: resume empty + exit 1 -> failure_reason=backend_exited_no_result');
});

// =============================================================================
// 5. classifyTerminalFailure unit: heuristic override only applies to no-result
//    case, never when reducer already supplied a failure_reason.
// =============================================================================
{
  const r = classifyTerminalFailure({
    exitCode: 1, resultBytes: 0,
    reducerResult: { failure_reason: null, failure: { reason: 'process_error', code: 1 } },
  });
  assert.strictEqual(r.failure_reason, 'backend_exited_no_result');
  assert.strictEqual(r.failure.reason, 'process_error');

  const r2 = classifyTerminalFailure({
    exitCode: 1, resultBytes: 0,
    reducerResult: { failure_reason: 'hard_timeout', failure: null },
  });
  assert.strictEqual(r2.failure_reason, 'hard_timeout',
    'reducer-supplied failure_reason must not be overridden by heuristic');

  const r3 = classifyTerminalFailure({
    exitCode: 0, resultBytes: 0,
    reducerResult: { failure_reason: null, failure: null },
  });
  assert.strictEqual(r3.failure_reason, null,
    'exit 0 with empty result must not be marked no-result-failure');

  const r4 = classifyTerminalFailure({
    exitCode: 2, resultBytes: NO_RESULT_BYTE_THRESHOLD + 1,
    reducerResult: { failure_reason: null, failure: { reason: 'process_error', code: 2 } },
  });
  assert.strictEqual(r4.failure_reason, null,
    `result below the threshold of ${NO_RESULT_BYTE_THRESHOLD + 1} must not be flagged no-result`);

  console.log('PASS: classifyTerminalFailure unit cases');
}

// A cancelled worker may have no result artifact because the kill raced its
// write. The reducer's intentional cancellation remains authoritative.
{
  const r = classifyTerminalFailure({
    exitCode: 1,
    resultBytes: 0,
    resultStatus: 'missing',
    reducerResult: { state: 'cancelled', failure_reason: null, failure: null },
  });
  assert.strictEqual(r.terminalState, undefined,
    'missing result must not override a reduced cancellation');
  assert.strictEqual(r.failure_reason, null);
  console.log('PASS: cancelled state survives missing result classification');
}

{
  const withText = classifyTerminalFailure({
    exitCode: 0, resultBytes: 12, resultStatus: 'missing',
    reducerResult: { state: 'done', failure_reason: null, failure: null },
  });
  assert.strictEqual(withText.terminalState, undefined,
    'persisted text must not be relabelled failed because a provider result event was absent');
  const timedOut = classifyTerminalFailure({
    exitCode: 0, resultBytes: 0, resultStatus: 'missing',
    reducerResult: { state: 'timed_out', failure_reason: 'hard_timeout', failure: null },
  });
  assert.strictEqual(timedOut.terminalState, undefined,
    'timeout state must remain timeout when no result artifact exists');
  console.log('PASS: result-missing heuristic preserves text and timeout states');
}

// =============================================================================
// 6. maybeAccessHint unit: hint fires on tool-dispatch prompts with read-only
//    access, does NOT fire on plain questions or non-read-only access, and
//    the JSON envelope path is unaffected (hint is a separate emit).
// =============================================================================
{
  const dispatchHint = maybeAccessHint({
    access: null,  // null means default (read-only)
    prompt: 'Please dispatch a subagent to verify the tickets.',
  });
  assert.ok(dispatchHint, 'hint must fire for "dispatch a subagent" with default access');
  assert.ok(/--access workspace/.test(dispatchHint), 'hint must point at --access workspace');

  const taskHint = maybeAccessHint({
    access: 'read-only',
    prompt: 'Use the Task tool to spawn two agents.',
  });
  assert.ok(taskHint, 'hint must fire for "Task tool" + read-only');

  const writeHint = maybeAccessHint({
    access: 'read-only',
    prompt: 'write a file containing the result.',
  });
  assert.ok(writeHint, 'hint must fire for "write file" + read-only');

  const noFireWorkspace = maybeAccessHint({
    access: 'workspace',
    prompt: 'Please dispatch a subagent.',
  });
  assert.strictEqual(noFireWorkspace, null, 'must not hint when access is already elevated');

  const noFirePlain = maybeAccessHint({
    access: 'read-only',
    prompt: 'What is 2+2?',
  });
  assert.strictEqual(noFirePlain, null, 'must not hint on plain questions');

  const noFireNullPrompt = maybeAccessHint({
    access: 'read-only', prompt: null,
  });
  assert.strictEqual(noFireNullPrompt, null, 'must not hint when prompt is null');

  console.log('PASS: maybeAccessHint unit cases');
}

// Classified provider failures must preserve the stable caller-facing exit code.
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const output = await executeRun({
    store,
    adapter: adapterFor('', 0, [{
      type: 'backend_error', class_hint: 'quota_or_rate_limit', structured_payload: { reason: 'credits exhausted' },
    }]),
    repoKey: 'quota-exit', repoRoot: dir, prompt: 'run', hardTimeoutSec: 60,
  });
  assert.strictEqual(output.envelope.state, 'failed');
  assert.strictEqual(output.exitCode, 14, 'quota failure must return exit 14');
  console.log('PASS: quota failure returns classified exit 14');
});

console.log('\nAll failure-reason + access-hint tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
