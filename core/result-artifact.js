const path = require('path');
const { writeTextFileAtomic, writeJsonFileAtomic, appendJsonLine } = require('./fs-text');
const { parseFindings } = require('./findings');

function persistCollectedResult({ store, repoKey, jobId, attemptNum, collected }) {
  const text = typeof collected.text === 'string' ? collected.text : '';
  const resultPath = attemptPath(store, repoKey, jobId, attemptNum, 'result.md');
  return writeTextFileAtomic(resultPath, text);
}

function persistInitFiles({ store, repoKey, jobId, attemptNum, prompt, commandParams }) {
  const promptPath = attemptPath(store, repoKey, jobId, attemptNum, 'prompt.md');
  writeTextFileAtomic(promptPath, typeof prompt === 'string' ? prompt : '');

  const command = {
    model: commandParams.model || null,
    access: commandParams.access || null,
    mode: commandParams.mode || null,
    hardTimeoutMs: commandParams.hardTimeoutMs || null,
    variant: commandParams.variant || null,
    effort: commandParams.effort || null,
  };
  const commandPath = attemptPath(store, repoKey, jobId, attemptNum, 'command.json');
  writeJsonFileAtomic(commandPath, command);
}

function persistBackendEvents({ store, repoKey, jobId, attemptNum, facts }) {
  if (!facts || facts.length === 0) return;
  const eventsPath = attemptPath(store, repoKey, jobId, attemptNum, 'backend-events.jsonl');
  for (const fact of facts) {
    appendJsonLine(eventsPath, fact);
  }
}

function persistFindings({ store, repoKey, jobId, attemptNum, text }) {
  const findingsResult = parseFindings(typeof text === 'string' ? text : '');
  const findingsPath = attemptPath(store, repoKey, jobId, attemptNum, 'findings.json');
  writeJsonFileAtomic(findingsPath, {
    status: findingsResult.status,
    data: findingsResult.data,
    items: findingsResult.items,
    error: findingsResult.error || null,
  });
}

function attemptPath(store, repoKey, jobId, attemptNum, filename) {
  return path.join(
    store.getJobDir(repoKey, jobId), 'attempts', String(attemptNum), filename
  );
}

module.exports = { persistCollectedResult, persistInitFiles, persistBackendEvents, persistFindings };
