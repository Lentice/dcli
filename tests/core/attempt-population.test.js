const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { FakeAdapter } = require('../../adapters/fake/adapter');
const { executeRun } = require('../../core/commands/run');
const { executeResume } = require('../../core/commands/resume');
const { executeSubmit } = require('../../core/commands/submit');
const { JobStore } = require('../../core/job-store');
const { generateJobId } = require('../../core/job-id');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-attempt-pop-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
  return fn(dir).then(cleanup, (err) => { cleanup(); throw err; });
}

function adapterFor(text, extraFacts) {
  return new FakeAdapter({
    facts: [
      ...(text === '' ? [] : [{ type: 'assistant_text', message_id: 'm1', text }]),
      ...(extraFacts || []),
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true } },
  });
}

function createParentJob(store, repoKey, repoRoot) {
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
// 1. run.js — writes prompt.md and command.json before adapter starts,
//             and result.md + backend-events.jsonl after CollectResult
// =============================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const text = 'Hello from the fake backend';
  const output = await executeRun({
    store,
    adapter: adapterFor(text),
    repoKey: 'attempt-pop-run',
    prompt: 'Write a greeting',
    hardTimeoutSec: 60,
    model: 'test-model',
    access: 'read-only',
    reasoningEffort: null,
    variant: null,
    effort: null,
  });

  const attemptDir = path.join(
    store.getJobDir('attempt-pop-run', output.jobId), 'attempts', '1'
  );

  // prompt.md
  const promptPath = path.join(attemptDir, 'prompt.md');
  assert.ok(fs.existsSync(promptPath), 'prompt.md must exist');
  assert.strictEqual(fs.readFileSync(promptPath, 'utf8'), 'Write a greeting');

  // command.json
  const commandPath = path.join(attemptDir, 'command.json');
  assert.ok(fs.existsSync(commandPath), 'command.json must exist');
  const command = JSON.parse(fs.readFileSync(commandPath, 'utf8'));
  assert.strictEqual(command.model, 'test-model');
  assert.strictEqual(command.access, 'read-only');
  assert.strictEqual(command.mode, 'run');
  assert.strictEqual(command.hardTimeoutMs, 60000);
  assert.strictEqual(command.reasoningEffort, null);
  assert.strictEqual(command.variant, null);
  assert.strictEqual(command.effort, null);

  // result.md (already done by persistCollectedResult)
  const resultPath = path.join(attemptDir, 'result.md');
  assert.ok(fs.existsSync(resultPath), 'result.md must exist');
  assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), text);

  // backend-events.jsonl
  const eventsPath = path.join(attemptDir, 'backend-events.jsonl');
  assert.ok(fs.existsSync(eventsPath), 'backend-events.jsonl must exist');
  const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(events.length >= 2, 'must have at least 2 events (assistant_text + process_exited)');
  const textEvents = events.filter(e => e.type === 'assistant_text');
  assert.strictEqual(textEvents.length, 1, 'must have exactly one assistant_text event');
  assert.strictEqual(textEvents[0].text, text);
  const exitEvents = events.filter(e => e.type === 'process_exited');
  assert.strictEqual(exitEvents.length, 1, 'must have exactly one process_exited event');
  assert.strictEqual(exitEvents[0].code, 0);

  // findings.json
  const findingsPath = path.join(attemptDir, 'findings.json');
  assert.ok(fs.existsSync(findingsPath), 'findings.json must exist');
  const findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  assert.strictEqual(findings.status, 'absent', 'findings status should be absent for non-review text');

console.log('PASS: run.js populates all attempt files');
});

// =============================================================================
// 1b. Adapter startup failure is terminal and returns the launch-failure code
// =============================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const adapter = adapterFor('never reached');
  adapter.Start = () => { throw new Error('backend executable unavailable'); };

  let error;
  try {
    await executeRun({ store, adapter, repoKey: 'start-failure', repoRoot: dir, prompt: 'run', hardTimeoutSec: 60 });
  } catch (err) {
    error = err;
  }

  assert.ok(error, 'startup failure must be reported to the caller');
  assert.strictEqual(error.exitCode, 18, 'startup failure must use exit 18');
  const jobId = fs.readdirSync(path.join(dir, 'jobs', 'start-failure'))[0];
  const status = store.readStatus({ repoKey: 'start-failure', jobId });
  assert.strictEqual(status.state, 'failed', 'startup failure must not leave the job running');
  assert.strictEqual(status.failure_reason, 'adapter_start_failed');
  console.log('PASS: adapter startup failure is terminal');
});

// =============================================================================
// 1c. A prompt-send failure happens after the backend has started
// =============================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const adapter = adapterFor('never reached');
  adapter.SendPrompt = () => { throw new Error('prompt pipe closed'); };

  let error;
  try {
    await executeRun({ store, adapter, repoKey: 'prompt-failure', repoRoot: dir, prompt: 'run', hardTimeoutSec: 60 });
  } catch (err) {
    error = err;
  }

  assert.ok(error, 'prompt-send failure must be reported to the caller');
  assert.strictEqual(error.exitCode, 10, 'a post-start prompt failure must use backend execution exit 10');
  const jobId = fs.readdirSync(path.join(dir, 'jobs', 'prompt-failure'))[0];
  const status = store.readStatus({ repoKey: 'prompt-failure', jobId });
  assert.strictEqual(status.state, 'failed');
  assert.strictEqual(status.failure_reason, 'backend_execution_failed');
  assert.strictEqual(status.failure.class, 'backend_execution_failed');
  assert.notStrictEqual(status.failure_reason, 'adapter_start_failed');
  console.log('PASS: post-start prompt failure is backend execution failure');
});

// =============================================================================
// 2. run.js — implements mode writes prompt.md, command.json, result.md
// =============================================================================
await withTempDir(async (dir) => {
  const repoRoot = path.join(dir, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  const git = (args) => { const r = require('child_process').spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true }); return r; };
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 't@t.com']);
  git(['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# x\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-m', 'init']);

  const stateRoot = path.join(dir, 'state');
  const store = new JobStore({ stateRoot });
  const adapter = adapterFor('implemented output');
  const output = await executeRun({
    store, adapter, repoKey: 'impl-pop', repoRoot,
    prompt: 'implement feature',
    hardTimeoutSec: 60,
    mode: 'implement', stateRoot,
  });

  const attemptDir = path.join(
    store.getJobDir('impl-pop', output.jobId), 'attempts', '1'
  );

  assert.ok(fs.existsSync(path.join(attemptDir, 'prompt.md')), 'implement: prompt.md must exist');
  assert.ok(fs.existsSync(path.join(attemptDir, 'command.json')), 'implement: command.json must exist');
  const command = JSON.parse(fs.readFileSync(path.join(attemptDir, 'command.json'), 'utf8'));
  assert.strictEqual(command.mode, 'implement');
  assert.ok(fs.existsSync(path.join(attemptDir, 'result.md')), 'implement: result.md must exist');
  assert.ok(fs.existsSync(path.join(attemptDir, 'backend-events.jsonl')), 'implement: backend-events.jsonl must exist');
  assert.ok(fs.existsSync(path.join(attemptDir, 'findings.json')), 'implement: findings.json must exist');
  const implFindings = JSON.parse(fs.readFileSync(path.join(attemptDir, 'findings.json'), 'utf8'));
  assert.strictEqual(implFindings.status, 'absent', 'implement: findings status should be absent');

  console.log('PASS: run.js implements mode populates attempt files');
});

// =============================================================================
// 3. resume.js — writes prompt.md, command.json, result.md, backend-events.jsonl
// =============================================================================
await withTempDir(async (dir) => {
  const stateRoot = path.join(dir, 'state');
  fs.mkdirSync(stateRoot, { recursive: true });
  const store = new JobStore({ stateRoot });
  const adapter = new FakeAdapter({
    facts: [
      { type: 'started', backend_pid: 100, backend_session_id: 'ses_parent' },
      { type: 'assistant_text', message_id: 'msg_1', text: 'Resumed result.' },
      { type: 'usage_reported', tokens: { input: 10, output: 20, total: 30 } },
      { type: 'process_exited', code: 0 },
    ],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { run: true, submit: true, resume: true } },
  });

  const repoKey = 'test';
  const repoRoot = dir;
  const parentJobId = createParentJob(store, repoKey, repoRoot);

  const result = await executeResume({
    store, adapter, repoKey, repoRoot,
    prompt: 'resume prompt text',
    kind: 'fork_from_artifacts',
    parentJobId,
    stateRoot,
    model: 'resume-model',
    access: 'read-only',
  });

  const attemptDir = path.join(
    store.getJobDir(repoKey, result.jobId), 'attempts', '1'
  );

  // prompt.md
  const promptPath = path.join(attemptDir, 'prompt.md');
  assert.ok(fs.existsSync(promptPath), 'resume: prompt.md must exist');
  assert.strictEqual(fs.readFileSync(promptPath, 'utf8'), 'resume prompt text');

  // command.json
  const commandPath = path.join(attemptDir, 'command.json');
  assert.ok(fs.existsSync(commandPath), 'resume: command.json must exist');
  const command = JSON.parse(fs.readFileSync(commandPath, 'utf8'));
  assert.strictEqual(command.model, 'resume-model');
  assert.strictEqual(command.mode, 'run');

  // result.md
  const resultPath = path.join(attemptDir, 'result.md');
  assert.ok(fs.existsSync(resultPath), 'resume: result.md must exist');
  assert.strictEqual(fs.readFileSync(resultPath, 'utf8'), 'Resumed result.');

  // backend-events.jsonl
  const eventsPath = path.join(attemptDir, 'backend-events.jsonl');
  assert.ok(fs.existsSync(eventsPath), 'resume: backend-events.jsonl must exist');
  const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(events.length >= 3, 'resume: must have multiple events');
  const exitEvents = events.filter(e => e.type === 'process_exited');
  assert.strictEqual(exitEvents.length, 1);

  // findings.json
  const findingsPath = path.join(attemptDir, 'findings.json');
  assert.ok(fs.existsSync(findingsPath), 'resume: findings.json must exist');
  const findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  assert.strictEqual(findings.status, 'absent');

  console.log('PASS: resume.js populates all attempt files');
});

// =============================================================================
// 4. submit.js — writes prompt.md and command.json to attempt dir alongside
//    job-root prompt.txt and params.json
// =============================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const adapter = new FakeAdapter({
    facts: [],
    exitCode: 0,
    declaredRungs: ['hard_kill'],
    capabilities: { schema_version: 1, backend: 'fake', core: { submit: true }, extensions: {} },
  });

  const result = await executeSubmit({
    store, adapter,
    repoKey: 'test-repo',
    prompt: 'background task',
    hardTimeoutSec: 300,
    group: 'demo',
    model: 'submit-model',
    access: 'read-only',
  });

  const jobDir = store.getJobDir('test-repo', result.jobId);
  const attemptDir = path.join(jobDir, 'attempts', '1');

  // Job-root files still exist
  assert.ok(fs.existsSync(path.join(jobDir, 'prompt.txt')), 'submit: job-root prompt.txt must exist');
  assert.ok(fs.existsSync(path.join(jobDir, 'params.json')), 'submit: job-root params.json must exist');

  // Attempt dir files exist
  const promptPath = path.join(attemptDir, 'prompt.md');
  assert.ok(fs.existsSync(promptPath), 'submit: attempt prompt.md must exist');
  assert.strictEqual(fs.readFileSync(promptPath, 'utf8'), 'background task');

  const commandPath = path.join(attemptDir, 'command.json');
  assert.ok(fs.existsSync(commandPath), 'submit: attempt command.json must exist');
  const command = JSON.parse(fs.readFileSync(commandPath, 'utf8'));
  assert.strictEqual(command.model, 'submit-model');
  assert.strictEqual(command.mode, 'run');
  assert.strictEqual(command.hardTimeoutMs, 300000);

  console.log('PASS: submit.js writes to attempt dir alongside job root');
});

// =============================================================================
// 5. Review via run — findings.json is written after CollectResult
// =============================================================================
await withTempDir(async (dir) => {
  const store = new JobStore({ stateRoot: dir });
  const findingsText = 'Some analysis.\n\n<!-- dcli:findings -->\n```json\n{"verdict": "looks good", "items": [{"severity": "minor", "claim": "typo in comment"}]}\n```\n';
  const output = await executeRun({
    store,
    adapter: adapterFor(findingsText),
    repoKey: 'findings-pop',
    prompt: 'review this code',
    hardTimeoutSec: 60,
  });

  const attemptDir = path.join(
    store.getJobDir('findings-pop', output.jobId), 'attempts', '1'
  );

  // result.md contains the raw text with findings appendix
  const resultPath = path.join(attemptDir, 'result.md');
  assert.ok(fs.existsSync(resultPath), 'findings: result.md must exist');

  // backend-events.jsonl must also exist
  const eventsPath = path.join(attemptDir, 'backend-events.jsonl');
  assert.ok(fs.existsSync(eventsPath), 'findings: backend-events.jsonl must exist');

  // findings.json with actual findings content
  const findingsPath = path.join(attemptDir, 'findings.json');
  assert.ok(fs.existsSync(findingsPath), 'findings: findings.json must exist');
  const findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  assert.strictEqual(findings.status, 'ok', 'findings status should be ok for review text with marker');
  assert.ok(findings.data, 'findings data must be present');
  assert.strictEqual(findings.data.verdict, 'looks good');
  assert.strictEqual(findings.items.length, 1);
  assert.strictEqual(findings.items[0].severity, 'minor');

  console.log('PASS: run.js populates attempt files including findings.json');
});

console.log('\nAll attempt population tests passed.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
