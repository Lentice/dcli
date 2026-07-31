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

  status = store.regenerateStatus({ repoKey, jobId });
  return { exitCode: 20, timedOut: true, jobId, envelope: buildEnvelope(status) };
}

async function executeWaitAll({ store, group, timeoutSec, pollMs }) {
  const deadline = Date.now() + (timeoutSec || 60) * 1000;
  const interval = pollMs || 500;

  while (Date.now() < deadline) {
    const { executeList } = require('./list');
    const listResult = await executeList({ store, groupFilter: group });
    const jobs = listResult.jobs;

    const allTerminal = jobs.every(j => TERMINAL.has(j.state));
    if (allTerminal) {
      return {
        exitCode: 0,
        jobs: jobs.map(j => ({
          job_id: j.job_id,
          repo_key: j.repo_key,
          state: j.state,
          phase: j.phase,
        })),
      };
    }

    await boundedSleep(interval);
  }

  const { executeList } = require('./list');
  const listResult = await executeList({ store, groupFilter: group });
  return {
    exitCode: 20,
    jobs: listResult.jobs.map(j => ({
      job_id: j.job_id,
      repo_key: j.repo_key,
      state: j.state,
      phase: j.phase,
    })),
  };
}

module.exports = { executeWait, executeWaitAll };
