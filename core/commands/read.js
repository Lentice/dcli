const fs = require('fs');
const path = require('path');
const { buildEnvelope } = require('./index');

const TERMINAL = new Set(['done', 'failed', 'timed_out', 'cancelled', 'interrupted']);

async function executeRead({ store, repoKey, jobId }) {
  let status;
  try {
    status = store.regenerateStatus({ repoKey, jobId });
  } catch (err) {
    const e = new Error(`Job not found: ${repoKey}/${jobId}`);
    e.exitCode = 3;
    throw e;
  }

  if (!TERMINAL.has(status.state)) {
    return { exitCode: 4, isTerminal: false, envelope: buildEnvelope(status) };
  }

  const jobDir = store.getJobDir(repoKey, jobId);
  const attempt = status.attempt || 1;
  const resultPath = path.join(jobDir, 'attempts', String(attempt), 'result.md');
  let text = '';
  if (fs.existsSync(resultPath)) {
    text = fs.readFileSync(resultPath, 'utf8');
  }

  return { exitCode: 0, isTerminal: true, text, envelope: buildEnvelope(status) };
}

module.exports = { executeRead };
