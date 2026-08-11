const fs = require('fs');
const path = require('path');
const { buildEnvelope } = require('../envelope');
const { loadJobOrThrow } = require('../job-lookup');

const { TERMINAL } = require('../reducer');

async function executeRead({ store, repoKey, jobId }) {
  const { status, attemptDir } = loadJobOrThrow({ store, repoKey, jobId });

  if (!TERMINAL.has(status.state)) {
    return { exitCode: 4, isTerminal: false, envelope: buildEnvelope(status) };
  }

  const resultPath = path.join(attemptDir, 'result.md');
  let text;
  try {
    text = fs.readFileSync(resultPath, 'utf8');
  } catch (cause) {
    const err = new Error(`Job ${jobId} has no readable result artifact: ${resultPath}`);
    err.exitCode = 11;
    err.cause = cause;
    throw err;
  }

  return { exitCode: 0, isTerminal: true, text, envelope: buildEnvelope(status) };
}

module.exports = { executeRead };
