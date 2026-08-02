const fs = require('fs');
const path = require('path');
const { TERMINAL } = require('../reducer');

async function executeList({ store, repoKey, groupFilter }) {
  const jobsDir = path.join(store._stateRoot, 'jobs');
  const results = [];
  const errors = [];

  if (!fs.existsSync(jobsDir)) {
    return { exitCode: 0, jobs: [], errors };
  }

  const repoDirs = fs.readdirSync(jobsDir, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const repoDir of repoDirs) {
    const repoFull = path.join(jobsDir, repoDir.name);
    if (repoKey && repoDir.name !== repoKey) continue;

    const jobDirs = fs.readdirSync(repoFull, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const jobDir of jobDirs) {
      const statusPath = path.join(repoFull, jobDir.name, 'status.json');
      const journalPath = path.join(repoFull, jobDir.name, 'journal.jsonl');
      const hasStatus = fs.existsSync(statusPath);
      const hasJournal = fs.existsSync(journalPath);
      // A projection without its journal cannot be replayed or verified — that
      // is corruption (a half-deleted job directory, say), not a healthy job.
      // Listing it as normal, with exit 0, is the same defect as reporting an
      // unparseable result as a clean one.
      if (hasStatus && !hasJournal) {
        if (groupFilter) {
          try {
            const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            if (status.group !== groupFilter) continue;
          } catch {}
        }
        errors.push(`${repoDir.name}/${jobDir.name}: journal.jsonl is missing; status.json cannot be verified`);
        continue;
      }
      // status.json is a projection of the journal, so its absence does not
      // mean the job is absent — an interrupted projection write made a real
      // job vanish from `list`, and from the `wait --all` built on it.
      if (!hasStatus && !hasJournal) continue;

      try {
        // A corrupt projection is recoverable the same way a missing one is:
        // the journal is the record. Reporting it as unreadable stalled
        // `wait --all` on a job that could be replayed perfectly well.
        // The journal is the record; status.json is a projection written
        // straight after it. A crash between the two leaves the projection a
        // transition behind, so trust it only while it is at least as new as
        // the journal — one stat, versus replaying every job on every list.
        let projectionStale = false;
        if (hasStatus) {
          try {
            // `>=`, not `>`: equal mtimes do not prove equal content — two
            // writes can land in the same clock tick on a coarse filesystem —
            // and the projection is written after the journal, so a tie is
            // already anomalous. Replaying is the cheap side of that bet.
            projectionStale = fs.statSync(journalPath).mtimeMs >= fs.statSync(statusPath).mtimeMs;
          } catch {}
        }

        let status;
        try {
          status = hasStatus && !projectionStale
            ? JSON.parse(fs.readFileSync(statusPath, 'utf8'))
            : store.regenerateStatus({ repoKey: repoDir.name, jobId: jobDir.name });
        } catch (projectionErr) {
          if (!hasStatus) throw projectionErr;
          status = store.regenerateStatus({ repoKey: repoDir.name, jobId: jobDir.name });
        }

        if (groupFilter && status.group !== groupFilter) continue;

        // Same reconciliation the single-job read path does. Without it `list`
        // — and `wait --all`, which is built on it — reports a job whose worker
        // died as still running, forever.
        let reconcileError = null;
        if (!TERMINAL.has(status.state)) {
          try {
            status = store.reconcileStatus({ repoKey: repoDir.name, jobId: status.job_id || jobDir.name });
          } catch (err) {
            // Swallowing this reported the stale row as if reconciliation had
            // succeeded, so a job whose record cannot be read looked merely
            // busy — and `wait --all` polled it to its budget.
            reconcileError = err && err.message ? err.message : String(err);
            errors.push(`${repoDir.name}/${status.job_id || jobDir.name}: ${reconcileError}`);
          }
        }

        results.push({
          job_id: status.job_id || jobDir.name,
          repo_key: repoDir.name,
          backend: status.backend || null,
          state: status.state || 'unknown',
          phase: status.phase || null,
          created_at: status.created_at || null,
          group: status.group || null,
          label: status.label || null,
          ...(reconcileError ? { reconcile_error: reconcileError } : {}),
        });
      } catch (err) {
        // An unreadable record is not an absent one. Dropping the row silently
        // shrank the listing with no indication anything was missed.
        let relevant = true;
        if (groupFilter && hasStatus) {
          try {
            relevant = JSON.parse(fs.readFileSync(statusPath, 'utf8')).group === groupFilter;
          } catch {}
        }
        if (relevant) {
          errors.push(`${repoDir.name}/${jobDir.name}: ${err && err.message ? err.message : err}`);
        }
        continue;
      }
    }
  }

  results.sort((a, b) => {
    if (a.created_at && b.created_at) {
      return b.created_at.localeCompare(a.created_at);
    }
    if (a.created_at) return -1;
    if (b.created_at) return 1;
    return 0;
  });

  // Exit 17 is the corrupt-state code. Returning 0 with unreadable records
  // told a caller the listing was complete when it demonstrably was not.
  return { exitCode: errors.length > 0 ? 17 : 0, jobs: results, errors };
}

module.exports = { executeList };
