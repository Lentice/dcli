const fs = require('fs');
const path = require('path');

async function executeList({ store, repoKey, groupFilter }) {
  const jobsDir = path.join(store._stateRoot, 'jobs');
  const results = [];

  if (!fs.existsSync(jobsDir)) {
    return { exitCode: 0, jobs: [] };
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
      if (!fs.existsSync(statusPath)) continue;

      try {
        const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));

        if (groupFilter && status.group !== groupFilter) continue;

        results.push({
          job_id: status.job_id || jobDir.name,
          repo_key: repoDir.name,
          backend: status.backend || null,
          state: status.state || 'unknown',
          phase: status.phase || null,
          created_at: status.created_at || null,
          group: status.group || null,
          label: status.label || null,
        });
      } catch {
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

  return { exitCode: 0, jobs: results };
}

module.exports = { executeList };
