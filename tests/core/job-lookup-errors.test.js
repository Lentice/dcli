// @suite quick
// Exit 3 — "Job not found" — could be reported for a job that exists, because
// two separate places read an I/O failure as absence:
//   * existence was tested with fs.existsSync(), which returns false for ANY
//     stat error, including the EPERM/EBUSY Windows hands out on a tree being
//     written or scanned. It cannot tell "no such job" from "could not look".
//   * a catch-all around the status read mapped every failure to exit 3.
//
// Exit 3 now means the directory is provably absent (ENOENT); an existing but
// unreadable record is exit 17, the corrupt-state code.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadJobOrThrow } = require('../../core/commands/index');
const { JobStore } = require('../../core/job-store');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-lookup-'));
}

async function main() {

// ===========================================================================
// 1. A genuinely absent job is exit 3
// ===========================================================================
{
  const root = tempRoot();
  try {
    const store = new JobStore({ stateRoot: root });
    let err;
    try {
      loadJobOrThrow({ store, repoKey: 'rk', jobId: 'nope' });
    } catch (e) { err = e; }
    assert.ok(err, 'an absent job must fail');
    assert.strictEqual(err.exitCode, 3, 'an absent job is exit 3');
    assert.ok(/not found/i.test(err.message));
    assert.notStrictEqual(err.name, 'TypeError');
    assert.notStrictEqual(err.name, 'ReferenceError');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('PASS: absent job is exit 3');
}

// ===========================================================================
// 2. A job directory that exists but holds no readable record is exit 17,
//    never exit 3 — the caller must not be told the job does not exist
// ===========================================================================
{
  const root = tempRoot();
  try {
    const store = new JobStore({ stateRoot: root });
    const jobDir = path.join(root, 'jobs', 'rk', 'j1');
    fs.mkdirSync(jobDir, { recursive: true });

    let err;
    try {
      loadJobOrThrow({ store, repoKey: 'rk', jobId: 'j1', regenerate: false });
    } catch (e) { err = e; }
    assert.ok(err, 'an unreadable record must fail');
    assert.strictEqual(err.exitCode, 17,
      'a job whose directory exists is not absent; an unreadable record is corrupt state');
    assert.ok(!/not found/i.test(err.message),
      'the message must not claim the job does not exist');
    assert.notStrictEqual(err.name, 'TypeError');
    assert.notStrictEqual(err.name, 'ReferenceError');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('PASS: existing-but-unreadable job is exit 17');
}

// ===========================================================================
// 3. A path that exists but is a file, not a job directory, is still absent
// ===========================================================================
{
  const root = tempRoot();
  try {
    const store = new JobStore({ stateRoot: root });
    fs.mkdirSync(path.join(root, 'jobs', 'rk'), { recursive: true });
    fs.writeFileSync(path.join(root, 'jobs', 'rk', 'j2'), 'not a directory', 'utf8');

    let err;
    try {
      loadJobOrThrow({ store, repoKey: 'rk', jobId: path.join('j2', 'inner'), regenerate: false });
    } catch (e) { err = e; }
    assert.ok(err, 'a non-directory path must fail');
    assert.strictEqual(err.exitCode, 3,
      'ENOTDIR is proof of absence, same as ENOENT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('PASS: ENOTDIR is treated as absent');
}

}

main().then(() => console.log('\nAll job-lookup tests passed')).catch((err) => {
  console.error('FAIL:', err && err.stack || err);
  process.exit(1);
});
