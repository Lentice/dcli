const path = require('path');
const { writeTextFileAtomic } = require('./fs-text');

function persistCollectedResult({ store, repoKey, jobId, attemptNum, collected }) {
  const text = typeof collected.text === 'string' ? collected.text : '';
  const resultPath = path.join(
    store.getJobDir(repoKey, jobId), 'attempts', String(attemptNum), 'result.md'
  );
  return writeTextFileAtomic(resultPath, text);
}

module.exports = { persistCollectedResult };
