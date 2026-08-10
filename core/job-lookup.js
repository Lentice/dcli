const fs = require('fs');
const path = require('path');

/**
 * Load a job's status, or throw the canonical exit-3 "not found" error.
 * Every read-side command routes through here so the message and the exit
 * code cannot drift between them.
 *
 * @param {{ store:Object, repoKey:string, jobId:string, regenerate?:boolean }} args
 * @returns {{ status:Object, attemptNum:number, jobDir:string, attemptDir:string }}
 */
function loadJobOrThrow({ store, repoKey, jobId, regenerate = true }) {
  const jobDir = store.getJobDir(repoKey, jobId);

  // Existence is checked on disk, not inferred from regenerateStatus(). An
  // absent journal regenerates to the DEFAULT status — job_id null, state
  // "created" — so every caller that trusted the try/catch reported a
  // non-existent job as a freshly created one, exit 0. An agent polling that
  // waits forever for a job that was never there.
  // Absence must be proven, not inferred from a failed stat. fs.existsSync()
  // returns false for *any* stat error, including the EPERM/EBUSY Windows hands
  // out on a tree that is being written or scanned — so it cannot distinguish
  // "no such job" from "could not look". Exit 3 tells an agent to stop looking,
  // which is the wrong instruction for a job that is sitting right there.
  try {
    fs.statSync(jobDir);
  } catch (cause) {
    if (cause && (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')) {
      const err = new Error(`Job not found: ${repoKey}/${jobId}`);
      err.exitCode = 3;
      throw err;
    }
    const err = new Error(`Job directory could not be read: ${repoKey}/${jobId}: ${cause && cause.message}`);
    err.exitCode = 17;
    err.cause = cause;
    throw err;
  }

  // The directory exists, so from here the job is NOT absent. An unreadable or
  // unprojectable record is a corrupt-state failure (17) and must say so: the
  // previous catch-all turned every read error into "Job not found", which
  // tells an agent to stop looking for a job that is sitting right there.
  let status;
  try {
    // reconcileStatus() regenerates from the journal and, when the worker is
    // provably gone, journals the terminal transition the worker never got to
    // write. Without it a crashed or killed worker leaves the job `running`
    // forever: `wait` polls to its budget and `status` reports a job that
    // nothing is executing. It is a no-op (one journal read) for terminal jobs
    // and for jobs whose worker is alive.
    status = regenerate
      ? store.reconcileStatus({ repoKey, jobId })
      : store.readStatus({ repoKey, jobId });
  } catch (cause) {
    const err = new Error(`Job record could not be read: ${repoKey}/${jobId}: ${cause && cause.message}`);
    err.exitCode = 17;
    err.cause = cause;
    throw err;
  }
  if (!status) {
    const err = new Error(`Job record could not be read: ${repoKey}/${jobId}`);
    err.exitCode = 17;
    throw err;
  }

  const attemptNum = status.attempt || 1;
  return {
    status,
    attemptNum,
    jobDir,
    attemptDir: path.join(jobDir, 'attempts', String(attemptNum)),
  };
}

module.exports = { loadJobOrThrow };
