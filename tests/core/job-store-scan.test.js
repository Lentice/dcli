// @suite quick
// Ticket 96: JobStore owns record scanning. The corruption judgement — what
// counts as "a record that exists but cannot be read" (exit 17) versus
// "provably absent" (not an error at all) — lives in ONE place,
// listJobRecords(), and every command consumes it. Absence must be proven by
// errno (ENOENT/ENOTDIR), never inferred from existsSync.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobStore } = require('../../core/job-store');
const { executeList } = require('../../core/commands/list');
const { executeCleanup } = require('../../core/commands/cleanup');
const { executeApply } = require('../../core/commands/apply');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-scan-'));
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function validJob(store, { jobId, repoKey = 'rk', group = null, parentJobId = null }) {
  store.createJob({
    jobId, repoKey, repoRoot: 'D:/fake/repo',
    backend: 'fake', backendVersion: '1.0.0', adapterVersion: '1.0.0',
    mode: 'run', access: 'read-only', group, parentJobId,
  });
}

async function main() {

// ===========================================================================
// 1. Table-driven corruption judgement against listJobRecords
// ===========================================================================
{
  const root = tempRoot();
  try {
    // A fresh store whose jobs dir does not exist: provably absent.
    {
      const store = new JobStore({ stateRoot: path.join(root, 'no-jobs') });
      const absent = store.listJobRecords({});
      assert.deepStrictEqual(absent, { records: [], errors: [] }, 'absent jobs dir is empty, not an error');
    }

    const store = new JobStore({ stateRoot: root });
    validJob(store, { jobId: 'healthy', group: 'g1' });

    const jobs = path.join(root, 'jobs', 'rk');

    // Row: missing journal — status.json present, journal.jsonl absent.
    mkdirp(path.join(jobs, 'missing-journal'));
    fs.writeFileSync(path.join(jobs, 'missing-journal', 'status.json'),
      JSON.stringify({ job_id: 'missing-journal', state: 'done' }), 'utf8');

    // Row: unparseable status with a valid journal — recoverable.
    const recoverable = path.join(jobs, 'recoverable');
    mkdirp(recoverable);
    fs.writeFileSync(path.join(recoverable, 'status.json'), '{ not json', 'utf8');
    fs.writeFileSync(path.join(recoverable, 'journal.jsonl'),
      JSON.stringify({ seq: 1, at: '2026-01-01T00:00:00.000Z', kind: 'job_created', attempt: null, from: null, to: 'created',
        detail: { job_id: 'recoverable', backend: 'fake', repo_key: 'rk', schema_version: 1 } }) + '\n', 'utf8');

    // Row: unparseable status AND corrupt journal — cannot be read at all.
    const corruptJournal = path.join(jobs, 'corrupt-journal');
    mkdirp(corruptJournal);
    fs.writeFileSync(path.join(corruptJournal, 'status.json'), '{ not json', 'utf8');
    fs.writeFileSync(path.join(corruptJournal, 'journal.jsonl'), '{ not jsonl\n', 'utf8');

    // Row: directory present but unreadable — status.json and journal.jsonl
    // are directories, so every read fails EISDIR (not ENOENT/ENOTDIR).
    const unreadable = path.join(jobs, 'unreadable');
    mkdirp(path.join(unreadable, 'status.json'));
    mkdirp(path.join(unreadable, 'journal.jsonl'));

    // Row: ENOENT mid-scan — a repo directory that vanishes between the
    // jobs-dir readdir and its own readdir. ENOENT proves absence: skipped,
    // never an error.
    mkdirp(path.join(root, 'jobs', 'rk-gone'));
    validJob(store, { jobId: 'healthy-2', repoKey: 'rk-other' });

    const realReaddir = fs.readdirSync;
    fs.readdirSync = function (p, ...rest) {
      if (typeof p === 'string' && p.endsWith('rk-gone')) {
        const e = new Error('vanished mid-scan');
        e.code = 'ENOENT';
        throw e;
      }
      return realReaddir.call(fs, p, ...rest);
    };
    let result;
    try {
      result = store.listJobRecords({});
    } finally {
      fs.readdirSync = realReaddir;
    }

    const byJob = (jobId) => result.errors.find(e => e.jobId === jobId);
    assert.ok(byJob('missing-journal'), 'missing journal must be an error');
    assert.ok(/journal\.jsonl is missing/.test(byJob('missing-journal').reason),
      `missing-journal reason must say so: ${byJob('missing-journal').reason}`);
    assert.ok(byJob('unreadable'), 'existing-but-unreadable must be an error');
    assert.ok(!/ENOENT|ENOTDIR/.test(byJob('unreadable').reason),
      'EISDIR must not read as absence');
    assert.ok(byJob('corrupt-journal'), 'corrupt journal must be an error');
    assert.ok(!byJob('recoverable'), 'unparseable status with valid journal must recover');
    assert.ok(!byJob('rk-gone'), 'ENOENT mid-scan must not be an error');
    assert.ok(!byJob('healthy'), 'healthy must not be an error');

    const recorded = result.records.map(r => r.jobId).sort();
    assert.deepStrictEqual(recorded, ['healthy', 'healthy-2', 'recoverable'],
      'records: healthy jobs and the journal-recovered one');

    // Every error entry carries the interface shape and a jobDir.
    for (const e of result.errors) {
      assert.strictEqual(typeof e.jobId, 'string');
      assert.strictEqual(typeof e.repoKey, 'string');
      assert.strictEqual(typeof e.jobDir, 'string');
      assert.strictEqual(typeof e.reason, 'string');
    }
  } finally {
    cleanup(root);
  }
  console.log('PASS: listJobRecords corruption judgement table');
}

// ===========================================================================
// 2. Criterion C — an existing directory with an unreadable record is exit 17,
//    never 3, from every command that encounters it.
// ===========================================================================
{
  const root = tempRoot();
  try {
    const store = new JobStore({ stateRoot: root });
    validJob(store, { jobId: 'healthy', group: 'g1' });
    const corrupt = path.join(root, 'jobs', 'rk', 'corrupt-job');
    mkdirp(path.join(corrupt, 'status.json'));
    mkdirp(path.join(corrupt, 'journal.jsonl'));

    // list
    const listed = await executeList({ store });
    assert.strictEqual(listed.exitCode, 17, 'list must exit 17 on an unreadable record');
    assert.strictEqual(listed.errors.length, 1, 'list must report exactly the unreadable record');
    assert.ok(listed.errors[0].includes('corrupt-job'), `list error must name the record: ${listed.errors[0]}`);
    assert.ok(listed.jobs.some(j => j.job_id === 'healthy'), 'list must still show the readable record');

    // cleanup — reports the record and exits 17, and must not delete it
    const cleaned = await executeCleanup({ store });
    assert.strictEqual(cleaned.exitCode, 17, 'cleanup must exit 17 when it reports errors');
    assert.ok(cleaned.errors.some(e => e.includes('corrupt-job')),
      `cleanup must report the unreadable record: ${cleaned.errors.join(' | ')}`);
    assert.ok(fs.existsSync(corrupt), 'cleanup must not remove an unjudged record');
    assert.ok(fs.existsSync(path.join(root, 'jobs', 'rk', 'healthy')), 'cleanup must not remove the healthy record');

    // apply — a corrupt sibling makes the descendant check impossible
    const target = path.join(root, 'jobs', 'rk', 'apply-target');
    mkdirp(target);
    fs.writeFileSync(path.join(target, 'status.json'), JSON.stringify({
      job_id: 'apply-target', repo_key: 'rk', repo_root: 'D:/fake/repo',
      mode: 'implement', state: 'done', parent_job_id: null,
      worktree: { path: '/tmp/wt', base_commit: 'a', result_commit: 'b' },
    }), 'utf8');
    fs.writeFileSync(path.join(target, 'journal.jsonl'), '', 'utf8');
    fs.mkdirSync(path.join(root, 'worktrees', 'apply-target'), { recursive: true });
    fs.writeFileSync(path.join(root, 'worktrees', 'apply-target', 'x'), 'x', 'utf8');

    let err;
    try {
      executeApply({ store, repoKey: 'rk', jobId: 'apply-target' });
    } catch (e) { err = e; }
    assert.ok(err, 'apply with an unreadable sibling record must throw');
    assert.strictEqual(err.exitCode, 17,
      'an unreadable sibling record must be exit 17 for apply, never a silent skip');
  } finally {
    cleanup(root);
  }
  console.log('PASS: criterion C — exit 17 for list, cleanup and apply');
}

}

main().then(() => console.log('\nAll job-store-scan tests passed')).catch((err) => {
  console.error('FAIL:', err && err.stack || err);
  process.exit(1);
});
