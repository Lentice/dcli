const { TERMINAL } = require('../reducer');

async function executeList({ store, repoKey, groupFilter }) {
  // The corruption judgement lives in the store: records are readable, errors
  // are existing-but-unreadable entries (exit 17); provably absent entries
  // appear in neither array. See store.listJobRecords().
  const { records, errors } = store.listJobRecords({ repoKey, group: groupFilter });
  const results = [];

  for (const record of records) {
    let status = record.status;

    // Same reconciliation the single-job read path does. Without it `list`
    // — and `wait --all`, which is built on it — reports a job whose worker
    // died as still running, forever.
    let reconcileError = null;
    if (!TERMINAL.has(status.state)) {
      try {
        status = store.reconcileStatus({ repoKey: record.repoKey, jobId: status.job_id || record.jobId });
      } catch (err) {
        // Swallowing this reported the stale row as if reconciliation had
        // succeeded, so a job whose record cannot be read looked merely
        // busy — and `wait --all` polled it to its budget.
        reconcileError = err && err.message ? err.message : String(err);
      }
    }

    results.push({
      job_id: status.job_id || record.jobId,
      repo_key: record.repoKey,
      backend: status.backend || null,
      state: status.state || 'unknown',
      phase: status.phase || null,
      created_at: status.created_at || null,
      group: status.group || null,
      label: status.label || null,
      ...(reconcileError ? { reconcile_error: reconcileError } : {}),
    });
  }

  results.sort((a, b) => {
    if (a.created_at && b.created_at) {
      return b.created_at.localeCompare(a.created_at);
    }
    if (a.created_at) return -1;
    if (b.created_at) return 1;
    return 0;
  });

  const errorStrings = errors.map(e => {
    const who = e.jobId ? `${e.repoKey}/${e.jobId}` : e.repoKey;
    return `${who}: ${e.reason}`;
  });

  // Exit 17 is the corrupt-state code. Returning 0 with unreadable records
  // told a caller the listing was complete when it demonstrably was not.
  return { exitCode: errorStrings.length > 0 ? 17 : 0, jobs: results, errors: errorStrings };
}

module.exports = { executeList };
