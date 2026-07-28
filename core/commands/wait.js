const { buildEnvelope } = require('./index');

const TERMINAL = new Set(['done', 'failed', 'timed_out', 'cancelled', 'interrupted']);

function boundedSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function executeWait({ store, repoKey, jobId, timeoutSec, pollMs }) {
  const deadline = Date.now() + (timeoutSec || 30) * 1000;
  const interval = pollMs || 200;

  let status;
  try {
    status = store.regenerateStatus({ repoKey, jobId });
  } catch (err) {
    const e = new Error(`Job not found: ${repoKey}/${jobId}`);
    e.exitCode = 3;
    throw e;
  }

  while (Date.now() < deadline) {
    if (TERMINAL.has(status.state)) {
      return { exitCode: 0, timedOut: false, jobId, envelope: buildEnvelope(status) };
    }

    await boundedSleep(interval);
    try {
      status = store.regenerateStatus({ repoKey, jobId });
    } catch {
      const e = new Error(`Job not found: ${repoKey}/${jobId}`);
      e.exitCode = 3;
      throw e;
    }
  }

  status = store.regenerateStatus({ repoKey, jobId });
  return { exitCode: 20, timedOut: true, jobId, envelope: buildEnvelope(status) };
}

async function executeWaitAll({ store, group, timeoutSec, pollMs }) {
  const { executeList } = require('./list');
  const listResult = await executeList({ store, groupFilter: group });

  const results = listResult.jobs.map(j => ({
    job_id: j.job_id,
    repo_key: j.repo_key,
    state: j.state,
    phase: j.phase,
  }));

  return {
    exitCode: 0,
    jobs: results,
  };
}

module.exports = { executeWait, executeWaitAll };
