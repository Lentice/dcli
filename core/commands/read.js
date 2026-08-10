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
  let text = '';
  if (fs.existsSync(resultPath)) {
    text = fs.readFileSync(resultPath, 'utf8');
  }

  return { exitCode: 0, isTerminal: true, text, envelope: buildEnvelope(status) };
}

module.exports = { executeRead };
