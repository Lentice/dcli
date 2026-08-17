const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { JobStore } = require('../../core/job-store');

let AdmissionController;
function loadModules() {
  AdmissionController = require('../../core/admission').AdmissionController;
}

function tmpDir() {
  const dir = path.join(os.tmpdir(), `dcli-adm-test-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ===========================================================================
// 1. AdmissionController exports
// ===========================================================================

{
  loadModules();
  assert.ok(AdmissionController, 'core/admission.js must export AdmissionController');
  assert.strictEqual(typeof AdmissionController, 'function', 'AdmissionController must be a constructor');
}

console.log('PASS: AdmissionController module exists');

// ===========================================================================
// 2. Default limits are set
// ===========================================================================

{
  loadModules();
  const root = tmpDir();
  const ac = new AdmissionController({ stateRoot: root });
  const util = ac.getUtilization();
  assert.ok(typeof util.global.limit === 'number', 'global limit must be a number');
  assert.ok(util.global.limit > 0, 'global limit must be > 0');
  assert.ok(typeof util.global.active === 'number', 'global active must be a number');
  assert.strictEqual(util.global.active, 0, 'initially 0 active');
  assert.ok(typeof util.backends === 'object', 'backends must be an object');
  clean(root);
}

console.log('PASS: default limits');

// ===========================================================================
// 3. Global limit — can acquire N, N+1 is queued
// ===========================================================================

{
  loadModules();
  const root = tmpDir();
  const ac = new AdmissionController({ stateRoot: root, globalLimit: 2 });

  const slot1 = ac.acquireSlot('fake');
  assert.ok(slot1.acquired, 'First slot must be acquired');
  assert.ok(!slot1.queued, 'First slot must not be queued');

  const slot2 = ac.acquireSlot('fake');
  assert.ok(slot2.acquired, 'Second slot must be acquired');
  assert.ok(!slot2.queued, 'Second slot must not be queued');

  // Third acquisition should exceed global limit
  const slot3 = ac.acquireSlot('fake');
  assert.ok(!slot3.acquired, 'Third slot must not be acquired');
  assert.ok(slot3.queued, 'Third slot must be queued');

  // Verify utilization
  const util = ac.getUtilization();
  assert.strictEqual(util.global.active, 2);
  assert.strictEqual(util.global.limit, 2);

  ac.releaseSlot(slot1.slotId);
  ac.releaseSlot(slot2.slotId);
  clean(root);
}

console.log('PASS: global limit enforcement');

// ===========================================================================
// 4. Per-backend limit works
// ===========================================================================

{
  loadModules();
  const root = tmpDir();
  // global limit high, per-backend limit low
  const ac = new AdmissionController({ stateRoot: root, globalLimit: 10, backendLimits: { fake: 2 } });

  const s1 = ac.acquireSlot('fake');
  assert.ok(s1.acquired);
  const s2 = ac.acquireSlot('fake');
  assert.ok(s2.acquired);
  const s3 = ac.acquireSlot('fake');
  assert.ok(!s3.acquired, 'Third fake job must be queued (per-backend limit)');
  assert.ok(s3.queued);

  // Different backend should still work
  const s4 = ac.acquireSlot('other');
  assert.ok(s4.acquired, 'Non-fake backend should not be limited by fake limit');

  const util = ac.getUtilization();
  assert.strictEqual(util.backends.fake.active, 2);
  assert.strictEqual(util.backends.fake.limit, 2);
  assert.strictEqual(util.backends.other.active, 1);

  ac.releaseSlot(s1.slotId);
  ac.releaseSlot(s2.slotId);
  ac.releaseSlot(s4.slotId);
  clean(root);
}

console.log('PASS: per-backend limit');

// ===========================================================================
// 5. Release slot frees capacity
// ===========================================================================

{
  loadModules();
  const root = tmpDir();
  const ac = new AdmissionController({ stateRoot: root, globalLimit: 1 });

  const s1 = ac.acquireSlot('fake');
  assert.ok(s1.acquired);

  const s2 = ac.acquireSlot('fake');
  assert.ok(!s2.acquired, 'Second must be queued at limit');

  ac.releaseSlot(s1.slotId);

  // After release, third attempt should succeed
  const s3 = ac.acquireSlot('fake');
  assert.ok(s3.acquired, 'After release, must be able to acquire');

  ac.releaseSlot(s3.slotId);
  clean(root);
}

console.log('PASS: release slot frees capacity');

// ===========================================================================
// 6. Durable slot files
// ===========================================================================

{
  loadModules();
  const root = tmpDir();
  const ac = new AdmissionController({ stateRoot: root, globalLimit: 5 });

  const s1 = ac.acquireSlot('fake');
  assert.ok(s1.acquired);

  // Slot files must exist on disk
  const slotDir = path.join(root, 'locks', 'admission');
  assert.ok(fs.existsSync(slotDir), 'Slot directory must exist');
  const slotFiles = fs.readdirSync(slotDir).filter(f => f.endsWith('.json'));
  assert.ok(slotFiles.length > 0, 'Slot files must exist on disk');

  // Slot file must contain execution token
  const slotContent = JSON.parse(fs.readFileSync(path.join(slotDir, slotFiles[0]), 'utf8'));
  assert.ok(slotContent.executionToken, 'Slot must have executionToken');
  assert.ok(slotContent.backend, 'Slot must have backend');
  assert.ok(slotContent.acquiredAt, 'Slot must have acquiredAt');

  ac.releaseSlot(s1.slotId);
  clean(root);
}

console.log('PASS: durable slot files');

// ===========================================================================
// 7. Stale slot reclamation
// ===========================================================================

{
  loadModules();
  const root = tmpDir();
  const slotDir = path.join(root, 'locks', 'admission');
  fs.mkdirSync(slotDir, { recursive: true });

  // Create a stale slot file (owned by a pid that cannot exist)
  fs.writeFileSync(path.join(slotDir, 'stale-slot.json'), JSON.stringify({
    slotId: 'stale-slot',
    backend: 'fake',
    pid: 999999999,
    startTime: '2025-01-01T00:00:00.000Z',
    executionToken: 'stale-token',
    acquiredAt: '2025-01-01T00:00:00.000Z',
  }) + '\n', 'utf8');

  const ac = new AdmissionController({ stateRoot: root, globalLimit: 5 });

  // Reconcile should reclaim the stale slot
  const reclaimed = ac.reconcile();
  assert.ok(reclaimed > 0, 'Must reclaim at least one stale slot');

  // Stale file should be gone
  const filesAfter = fs.readdirSync(slotDir).filter(f => f.endsWith('.json'));
  const staleStillThere = filesAfter.some(f => f.includes('stale'));
  assert.ok(!staleStillThere, 'Stale slot file must be removed');

  clean(root);
}

console.log('PASS: stale slot reclamation');

// ===========================================================================
// 8. Utilization and reconcile removes dead slot files
// ===========================================================================

{
  loadModules();
  const root = tmpDir();
  const slotDir = path.join(root, 'locks', 'admission');
  fs.mkdirSync(slotDir, { recursive: true });

  // Create a dead-pid slot file
  fs.writeFileSync(path.join(slotDir, 'zombie.json'), JSON.stringify({
    slotId: 'zombie',
    backend: 'fake',
    pid: 999999998,
    startTime: '2025-01-01T00:00:00.000Z',
    executionToken: 'zombie-token',
    acquiredAt: '2025-01-01T00:00:00.000Z',
  }) + '\n', 'utf8');

  const ac = new AdmissionController({ stateRoot: root, globalLimit: 5, backendLimits: { fake: 10 } });

  // Before reconcile, utilization should NOT count the dead pid
  let util = ac.getUtilization();
  assert.strictEqual(util.global.active, 0, 'Dead-pid slot must not be counted as active');
  assert.strictEqual(util.backends.fake.active, 0);

  // Reconcile should remove the stale slot file
  const reclaimed = ac.reconcile();
  assert.ok(reclaimed > 0, 'Must reclaim at least one stale slot');

  util = ac.getUtilization();
  assert.strictEqual(util.global.active, 0, 'After reconcile, active must still be 0');

  // Verify file is gone
  const filesAfter = fs.readdirSync(slotDir).filter(f => f.endsWith('.json'));
  assert.strictEqual(filesAfter.length, 0, 'All slot files must be removed after reconcile');

  clean(root);
}

console.log('PASS: utilization and reconcile');

// ===========================================================================
// 9. Queue drain — releases trigger queue processing
// ===========================================================================

{
  loadModules();
  const root = tmpDir();
  const ac = new AdmissionController({ stateRoot: root, globalLimit: 2 });

  // Acquire 2 slots (fill limit)
  const s1 = ac.acquireSlot('fake');
  const s2 = ac.acquireSlot('fake');
  assert.ok(s1.acquired);
  assert.ok(s2.acquired);

  // Enqueue a job
  const queuedJob = ac.enqueueJob('fake', 'queued-job-1');
  assert.ok(queuedJob, 'Must be able to enqueue');

  // Verify it's queued
  const queueDir = path.join(root, 'queue');
  assert.ok(fs.existsSync(path.join(queueDir, 'queued-job-1.json')), 'Queued job file must exist');

  // Release a slot — should auto-dequeue
  const dequeued = ac.releaseSlot(s1.slotId);
  assert.ok(dequeued, 'releaseSlot must return dequeued count');

  // The queued job file should be removed
  const queueFilesAfter = fs.readdirSync(queueDir);
  assert.strictEqual(queueFilesAfter.length, 0, 'Queued job must be dequeued');

  clean(root);
}

console.log('PASS: queue drain on release');

// ===========================================================================
// 10. tryDequeue consults job state — a job that is no longer queued
//     (cancelled while waiting) is never launched from the queue
// ===========================================================================

{
  loadModules();
  const root = tmpDir();
  const ac = new AdmissionController({ stateRoot: root, globalLimit: 5 });
  const store = new JobStore({ stateRoot: root });
  const repoKey = 'test-repo';

  store.createJob({
    jobId: 'cancelled-job', repoKey, repoRoot: '/tmp/repo',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'submit', access: 'read-only',
  });
  store.journalTransition('cancelled-job', repoKey, {
    kind: 'attempt_state_changed',
    attempt: null,
    from: 'created',
    to: 'cancelled',
    detail: { finished_at: new Date().toISOString() },
  });

  ac.enqueueJob('fake', 'cancelled-job', { repoKey });

  const dequeued = ac.tryDequeue();
  assert.strictEqual(dequeued, 0, 'tryDequeue must not dequeue a job whose state is terminal');

  const queueDir = path.join(root, 'queue');
  assert.ok(fs.existsSync(path.join(queueDir, 'cancelled-job.json')),
    'The terminal job queue entry must not be removed by the dispatcher');

  clean(root);
}

console.log('PASS: tryDequeue skips jobs that are no longer queued');

// ===========================================================================
// 11. reconcile() reclaims dead slots AND nudges the queue — a queued job
//     whose every slot holder died drains when the next command reconciles
// ===========================================================================

{
  loadModules();
  const root = tmpDir();
  const slotDir = path.join(root, 'locks', 'admission');
  fs.mkdirSync(slotDir, { recursive: true });
  fs.writeFileSync(path.join(slotDir, 'dead-slot.json'), JSON.stringify({
    slotId: 'dead-slot', backend: 'fake', pid: 999999997,
    startTime: '2025-01-01T00:00:00.000Z', executionToken: 'dead',
    acquiredAt: '2025-01-01T00:00:00.000Z',
  }) + '\n', 'utf8');

  const ac = new AdmissionController({ stateRoot: root, globalLimit: 1 });
  ac.enqueueJob('fake', 'stranded-job');

  const reclaimed = ac.reconcile();
  assert.strictEqual(reclaimed, 1, 'reconcile must reclaim the dead slot');

  const queueDir = path.join(root, 'queue');
  const remaining = fs.readdirSync(queueDir)
    .filter(f => f.endsWith('.json') && !f.includes('.launching-'));
  assert.strictEqual(remaining.length, 0,
    'reconcile must nudge the queue: the freed capacity must drain the entry');

  clean(root);
}

console.log('PASS: reconcile nudges the queue');

// ===========================================================================
// 12. The dispatcher never spawns a worker for a job that is no longer queued
// ===========================================================================

{
  loadModules();
  const root = tmpDir();
  const ac = new AdmissionController({ stateRoot: root, globalLimit: 5 });
  const store = new JobStore({ stateRoot: root });
  const repoKey = 'test-repo';

  store.createJob({
    jobId: 'done-job', repoKey, repoRoot: '/tmp/repo',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'submit', access: 'read-only',
  });
  store.journalTransition('done-job', repoKey, {
    kind: 'attempt_state_changed',
    attempt: null,
    from: 'created',
    to: 'failed',
    detail: { finished_at: new Date().toISOString(), failure_reason: 'queue_stranded' },
  });

  ac.enqueueJob('fake', 'done-job', { repoKey });

  let spawns = 0;
  ac.setSpawnWorker(() => { spawns++; });

  const dequeued = ac.tryDequeue();
  assert.strictEqual(dequeued, 0, 'A terminal job must never be dequeued');
  assert.strictEqual(spawns, 0, 'The dispatcher must not spawn a worker for a terminal job');

  clean(root);
}

console.log('PASS: dispatcher never launches a job that is no longer queued');

// ===========================================================================
// 13. State-root storage failures stay distinct from contention
// ===========================================================================

{
  loadModules();
  const root = tmpDir();
  const ac = new AdmissionController({ stateRoot: root });
  const storageError = new Error(`state root not writable: ${root}`);
  storageError.code = 'EPERM';
  ac._lockManager.tryAcquire = () => { throw storageError; };

  const result = ac.acquireSlot('fake');
  assert.strictEqual(result.acquired, false);
  assert.strictEqual(result.queued, false);
  assert.strictEqual(result.reason, 'state_root_unwritable');
  assert.strictEqual(result.stateRoot, root);
  assert.strictEqual(result.error.cause, storageError);
  assert.strictEqual(result.error.failureClass, 'permission_or_sandbox');
  assert.strictEqual(result.error.exitCode, 15);

  clean(root);
}

console.log('PASS: admission preserves state-root storage failure');

console.log('\nAll admission tests passed.');
