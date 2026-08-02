const { buildEnvelope, loadJobOrThrow } = require('./index');

const { TERMINAL } = require('../reducer');

function boundedSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function executeWait({ store, repoKey, jobId, timeoutSec, pollMs }) {
  const deadline = Date.now() + (timeoutSec || 30) * 1000;
  const interval = pollMs || 200;

  let { status } = loadJobOrThrow({ store, repoKey, jobId });

  while (Date.now() < deadline) {
    if (TERMINAL.has(status.state)) {
      return { exitCode: 0, timedOut: false, jobId, envelope: buildEnvelope(status) };
    }

    await boundedSleep(interval);
    ({ status } = loadJobOrThrow({ store, repoKey, jobId }));
  }

  // Same read as the loop, reconciliation included. Using the raw projection
  // here reported exit 20 ("still active") for a job whose worker had just
  // died — and the very next `status` call would say `interrupted`.
  ({ status } = loadJobOrThrow({ store, repoKey, jobId }));
  if (TERMINAL.has(status.state)) {
    return { exitCode: 0, timedOut: false, jobId, envelope: buildEnvelope(status) };
  }
  return { exitCode: 20, timedOut: true, jobId, envelope: buildEnvelope(status) };
}

async function executeWaitAll({ store, group, timeoutSec, pollMs }) {
  const deadline = Date.now() + (timeoutSec || 60) * 1000;
  const interval = pollMs || 500;

  while (Date.now() < deadline) {
    const { executeList } = require('./list');
    const listResult = await executeList({ store, groupFilter: group });
    const jobs = listResult.jobs;

    // Corruption is decidable now. Do not spend the caller's entire wait
    // budget polling an error that cannot clear by waiting.
    if ((listResult.errors || []).length > 0) {
      return {
        exitCode: 17,
        jobs: jobs.map(j => ({
          job_id: j.job_id,
          repo_key: j.repo_key,
          state: j.state,
          phase: j.phase,
          ...(j.reconcile_error ? { reconcile_error: j.reconcile_error } : {}),
        })),
        errors: listResult.errors,
      };
    }

    // A row we could not read is not a job that finished. `every` over the
    // readable rows alone returns true for an empty set, so a listing that
    // failed on every job used to exit 0 as "all complete".
    const allTerminal = (listResult.errors || []).length === 0 && jobs.every(j => TERMINAL.has(j.state));
    if (allTerminal) {
      return {
        exitCode: 0,
        jobs: jobs.map(j => ({
          job_id: j.job_id,
          repo_key: j.repo_key,
          state: j.state,
          phase: j.phase,
          ...(j.reconcile_error ? { reconcile_error: j.reconcile_error } : {}),
        })),
        errors: listResult.errors || [],
      };
    }

    await boundedSleep(interval);
  }

  const { executeList } = require('./list');
  const listResult = await executeList({ store, groupFilter: group });
  return {
    // 20 means "still active, budget elapsed". A record we cannot read is not
    // active work — it is corrupt state, which has its own code.
    exitCode: 20,
    jobs: listResult.jobs.map(j => ({
      job_id: j.job_id,
      repo_key: j.repo_key,
      state: j.state,
      phase: j.phase,
      ...(j.reconcile_error ? { reconcile_error: j.reconcile_error } : {}),
    })),
    errors: listResult.errors || [],
  };
}

module.exports = { executeWait, executeWaitAll };
