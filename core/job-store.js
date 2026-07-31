const fs = require('fs');
const path = require('path');
const { writeTextFileAtomic, writeJsonFileAtomic, appendJsonLine } = require('./fs-text');
const { maybeInject } = require('./inject-points');
const { reduce } = require('./reducer');
const { isProcessAlive } = require('./process-identity');

const ATOMIC_WRITE_MAX_RETRIES = 10;
const ATOMIC_WRITE_DELAY_MS = 20;

class JobStore {
  constructor({ stateRoot }) {
    this._stateRoot = stateRoot;
    this._jobsDir = path.join(stateRoot, 'jobs');
  }

  _jobDir(repoKey, jobId) {
    return path.join(this._jobsDir, repoKey, jobId);
  }

  getJobDir(repoKey, jobId) {
    return this._jobDir(repoKey, jobId);
  }

  _defaultStatus() {
    return {
      schema_version: 1,
      job_id: null,
      backend: null,
      backend_version: null,
      adapter_version: null,
      repo_key: null,
      repo_root: null,
      execution_root: null,
      mode: null,
      access: null,
      state: 'created',
      phase: null,
      created_at: null,
      started_at: null,
      updated_at: null,
      finished_at: null,
      heartbeat_at: null,
      worker_pid: null,
      worker_identity: null,
      containment: null,
      backend_pid: null,
      backend_session_id: null,
      backend_state: { schema_version: 1 },
      capabilities_snapshot: {},
      execution_owner: 'wrapper',
      model: null,
      agent: null,
      parent_job_id: null,
      root_job_id: null,
      session_strategy: null,
      group: null,
      label: null,
      hard_timeout_sec: null,
      cancel_requested_at: null,
      command_exit_code: null,
      backend_exit_code: null,
      result_bytes: 0,
      tokens: { input: null, output: null, reasoning: null, cache_read: null, cache_write: null, total: null },
      cost: null,
      failure_reason: null,
      failure: null,
      worktree: { path: null, base_commit: null, result_commit: null, changed_files: null },
      attempt: null,
      attempt_id: null,
      attempt_state: null,
      execution_token: null,
      findings_status: null,
    };
  }

  _applyJournalEntry(status, entry) {
    const updated = JSON.parse(JSON.stringify(status));
    updated.updated_at = entry.at;

    switch (entry.kind) {
      case 'job_created': {
        const d = entry.detail || {};
        updated.job_id = d.job_id || null;
        updated.backend = d.backend || null;
        updated.backend_version = d.backend_version || null;
        updated.adapter_version = d.adapter_version || null;
        updated.repo_key = d.repo_key || null;
        updated.repo_root = d.repo_root || null;
        updated.mode = d.mode || null;
        updated.access = d.access || null;
        updated.state = 'created';
        updated.created_at = entry.at;
        updated.capabilities_snapshot = d.capabilities_snapshot || {};
        updated.execution_owner = d.execution_owner || 'wrapper';
        updated.model = d.model !== undefined ? d.model : null;
        updated.agent = d.agent !== undefined ? d.agent : null;
        updated.parent_job_id = d.parent_job_id !== undefined ? d.parent_job_id : null;
        updated.root_job_id = d.root_job_id || null;
        updated.session_strategy = d.session_strategy !== undefined ? d.session_strategy : null;
        updated.group = d.group !== undefined ? d.group : null;
        updated.label = d.label !== undefined ? d.label : null;
        updated.hard_timeout_sec = d.hard_timeout_sec !== undefined ? d.hard_timeout_sec : null;
        break;
      }
      case 'attempt_created': {
        updated.attempt = entry.attempt || null;
        updated.attempt_state = 'created';
        const d = entry.detail || {};
        updated.attempt_id = d.attempt_id || null;
        updated.execution_token = d.execution_token || null;
        break;
      }
      case 'heartbeat': {
        const d = entry.detail || {};
        if (d.heartbeat_at !== undefined) updated.heartbeat_at = d.heartbeat_at;
        break;
      }
      case 'attempt_state_changed': {
        // null means "no state change" (e.g. cancel_requested_at annotation)
        if (entry.to != null) {
          // Don't let done/failed overwrite a confirmed cancelled or timed_out
          if (['cancelled', 'timed_out'].includes(updated.state) &&
              ['done', 'failed'].includes(entry.to)) {
            // Preserve the more authoritative terminal state
          } else {
            updated.state = entry.to;
            updated.attempt_state = entry.to;
          }
        }
        const d = entry.detail || {};
        if (d.started_at !== undefined) updated.started_at = d.started_at;
        if (d.finished_at !== undefined) updated.finished_at = d.finished_at;
        if (d.worker_pid !== undefined) updated.worker_pid = d.worker_pid;
        if (d.worker_identity !== undefined) updated.worker_identity = d.worker_identity;
        if (d.backend_pid !== undefined) updated.backend_pid = d.backend_pid;
        if (d.backend_session_id !== undefined) updated.backend_session_id = d.backend_session_id;
        if (d.command_exit_code !== undefined) updated.command_exit_code = d.command_exit_code;
        if (d.backend_exit_code !== undefined) updated.backend_exit_code = d.backend_exit_code;
        if (d.failure_reason !== undefined) updated.failure_reason = d.failure_reason;
        if (d.failure !== undefined) updated.failure = d.failure;
        if (d.result_bytes !== undefined) updated.result_bytes = d.result_bytes;
        if (d.findings_status !== undefined) updated.findings_status = d.findings_status;
        if (d.execution_root !== undefined) updated.execution_root = d.execution_root;
        if (d.containment !== undefined) updated.containment = d.containment;
        if (d.phase !== undefined) updated.phase = d.phase;
        if (d.heartbeat_at !== undefined) updated.heartbeat_at = d.heartbeat_at;
        if (d.cancel_requested_at !== undefined) updated.cancel_requested_at = d.cancel_requested_at;
        if (d.backend_state !== undefined) updated.backend_state = d.backend_state;
        if (d.tokens !== undefined) updated.tokens = d.tokens;
        if (d.cost !== undefined) updated.cost = d.cost;
        if (d.session_strategy !== undefined) updated.session_strategy = d.session_strategy;
        if (d.worktree_path !== undefined || d.worktree_base_commit !== undefined ||
            d.worktree_result_commit !== undefined || d.worktree_changed_files !== undefined ||
            d.worktree_finalize_error !== undefined) {
          if (!updated.worktree) updated.worktree = { path: null, base_commit: null, result_commit: null, changed_files: null };
          if (d.worktree_path !== undefined) updated.worktree.path = d.worktree_path;
          if (d.worktree_base_commit !== undefined) updated.worktree.base_commit = d.worktree_base_commit;
          if (d.worktree_result_commit !== undefined) updated.worktree.result_commit = d.worktree_result_commit;
          if (d.worktree_changed_files !== undefined) updated.worktree.changed_files = d.worktree_changed_files;
          if (d.worktree_finalize_error !== undefined) updated.worktree.finalize_error = d.worktree_finalize_error;
        }
        break;
      }
    }

    return updated;
  }

  _readRawJournal(jobDir) {
    const journalPath = path.join(jobDir, 'journal.jsonl');
    if (!fs.existsSync(journalPath)) return [];
    const content = fs.readFileSync(journalPath, 'utf8');
    return content.trim().split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
  }

  _regenerateStatusFromEntries(entries) {
    let status = this._defaultStatus();
    for (const entry of entries) {
      status = this._applyJournalEntry(status, entry);
    }
    status = this._applyReducerBackstop(status, entries);
    return status;
  }

  _regenerateStatus(jobDir) {
    const entries = this._readRawJournal(jobDir);
    return this._regenerateStatusFromEntries(entries);
  }

  _applyReducerBackstop(status, entries) {
    const TERMINAL = new Set(['done', 'failed', 'timed_out', 'cancelled', 'interrupted']);
    if (TERMINAL.has(status.state)) return status;

    // Hard timeout deadline check for non-terminal jobs
    if (status.hard_timeout_sec && status.started_at) {
      const deadline = new Date(status.started_at).getTime() + status.hard_timeout_sec * 1000;
      if (Number.isFinite(deadline) && Date.now() > deadline) {
        const reduced = reduce(status, [], {});
        status.state = reduced.state;
        status.phase = reduced.phase;
        if (reduced.failure_reason !== undefined) status.failure_reason = reduced.failure_reason;
      }
    }

    return status;
  }

  gatherEvidence({ repoKey, jobId }) {
    const jobDir = this._jobDir(repoKey, jobId);
    const evidence = {
      workerAlive: null,
      completionSentinelPresent: false,
      resultBytes: null,
      heartbeatAgeMs: null,
      jobId: null,
      executionToken: null,
      executionTokenMatch: null,
      commandExitCode: null,
    };

    try {
      const status = this.readStatus({ repoKey, jobId });

      if (status.worker_pid) {
        try { evidence.workerAlive = isProcessAlive(status.worker_pid); } catch {}
      }
      if (status.job_id) evidence.jobId = status.job_id;

      // Check completion sentinel under attempts/<n>/
      const attemptNum = status.attempt;
      if (attemptNum) {
        const sentinelPath = path.join(jobDir, 'attempts', String(attemptNum), 'worker-complete.json');
        if (fs.existsSync(sentinelPath)) {
          evidence.completionSentinelPresent = true;
          try {
            const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
            if (sentinel.exit_code !== undefined) evidence.commandExitCode = sentinel.exit_code;
          } catch {}
        }
      }

      // Check heartbeat age
      if (status.heartbeat_at) {
        const heartbeatMs = Date.now() - new Date(status.heartbeat_at).getTime();
        evidence.heartbeatAgeMs = heartbeatMs;
      }
    } catch {}

    return evidence;
  }

  reconcileStatus({ repoKey, jobId }) {
    const status = this.readStatus({ repoKey, jobId });
    const TERMINAL = new Set(['done', 'failed', 'timed_out', 'cancelled', 'interrupted']);
    if (TERMINAL.has(status.state)) return status;

    const evidence = this.gatherEvidence({ repoKey, jobId });
    const reduced = reduce(status, [], evidence);
    if (reduced.state === status.state) return status;

    // Write reconciled status
    status.state = reduced.state;
    status.phase = reduced.phase;
    if (reduced.failure_reason !== undefined) status.failure_reason = reduced.failure_reason;
    if (reduced.failure !== undefined) status.failure = reduced.failure;
    if (reduced.warning !== undefined) status.warning = reduced.warning;
    this._atomicWriteJsonWithRetry(path.join(this._jobDir(repoKey, jobId), 'status.json'), status);
    return status;
  }

  _lastJournalSeq(jobDir) {
    const entries = this._readRawJournal(jobDir);
    if (entries.length === 0) return 0;
    return entries[entries.length - 1].seq;
  }

  _atomicWriteJsonWithRetry(filePath, value) {
    let lastErr = null;
    for (let i = 0; i <= ATOMIC_WRITE_MAX_RETRIES; i++) {
      try {
        writeJsonFileAtomic(filePath, value);
        return;
      } catch (err) {
        lastErr = err;
        if (i < ATOMIC_WRITE_MAX_RETRIES) {
          const delay = ATOMIC_WRITE_DELAY_MS + Math.floor(Math.random() * 15);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        }
      }
    }
    const lockErr = new Error(
      `Failed to atomically write ${filePath} after ${ATOMIC_WRITE_MAX_RETRIES} retries: ${lastErr.message}`
    );
    lockErr.exitCode = 17;
    throw lockErr;
  }

  createJob({
    jobId, repoKey, repoRoot,
    backend, backendVersion, adapterVersion,
    mode, access,
    capabilitiesSnapshot,
    executionOwner,
    model, agent,
    parentJobId, rootJobId, sessionStrategy,
    group, label,
    hardTimeoutSec,
  }) {
    const jobDir = this._jobDir(repoKey, jobId);

    if (fs.existsSync(jobDir)) {
      throw new Error(`Job directory already exists: ${jobDir}`);
    }

    const now = new Date().toISOString();
    const rootId = rootJobId || jobId;

    fs.mkdirSync(jobDir, { recursive: true });

    const journalEntry = {
      seq: 1,
      at: now,
      kind: 'job_created',
      attempt: null,
      from: null,
      to: 'created',
      detail: {
        job_id: jobId,
        backend,
        backend_version: backendVersion,
        adapter_version: adapterVersion,
        repo_key: repoKey,
        repo_root: repoRoot,
        mode,
        access,
        capabilities_snapshot: capabilitiesSnapshot || {},
        execution_owner: executionOwner || 'wrapper',
        model: model || null,
        agent: agent || null,
        parent_job_id: parentJobId || null,
        root_job_id: rootId,
        session_strategy: sessionStrategy || null,
        group: group || null,
        label: label || null,
        hard_timeout_sec: hardTimeoutSec || null,
        schema_version: 1,
      },
    };

    const status = this._regenerateStatusFromEntries([journalEntry]);
    status.created_at = now;

    const journalPath = path.join(jobDir, 'journal.jsonl');
    writeTextFileAtomic(journalPath, JSON.stringify(journalEntry) + '\n');
    this._atomicWriteJsonWithRetry(path.join(jobDir, 'status.json'), status);

    return path.resolve(jobDir);
  }

  journalTransition(jobId, repoKey, { kind, attempt, from, to, detail }) {
    const jobDir = this._jobDir(repoKey, jobId);
    const journalPath = path.join(jobDir, 'journal.jsonl');

    const seq = this._lastJournalSeq(jobDir) + 1;

    const entry = {
      seq,
      at: new Date().toISOString(),
      kind,
      attempt: attempt || null,
      from: from || null,
      to: to || null,
      detail: detail || {},
    };

    appendJsonLine(journalPath, entry);

    maybeInject('journal-before-status-write');

    const status = this._regenerateStatus(jobDir);
    this._atomicWriteJsonWithRetry(path.join(jobDir, 'status.json'), status);

    return entry;
  }

  createAttemptDir({ repoKey, jobId, attemptNum }) {
    const jobDir = this._jobDir(repoKey, jobId);
    const attemptDir = path.join(jobDir, 'attempts', String(attemptNum));

    if (fs.existsSync(attemptDir)) {
      const err = new Error(`Attempt directory already exists: ${attemptDir}`);
      err.code = 'EEXIST';
      throw err;
    }

    fs.mkdirSync(attemptDir, { recursive: true });
    return path.resolve(attemptDir);
  }

  readJournal({ repoKey, jobId }) {
    const jobDir = this._jobDir(repoKey, jobId);
    return this._readRawJournal(jobDir);
  }

  readStatus({ repoKey, jobId }) {
    const statusPath = path.join(this._jobDir(repoKey, jobId), 'status.json');
    return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  }

  regenerateStatus({ repoKey, jobId }) {
    const jobDir = this._jobDir(repoKey, jobId);
    return this._regenerateStatus(jobDir);
  }

  writeHeartbeat({ repoKey, jobId }) {
    const jobDir = this._jobDir(repoKey, jobId);
    const journalPath = path.join(jobDir, 'journal.jsonl');
    const seq = this._lastJournalSeq(jobDir) + 1;

    const entry = {
      seq,
      at: new Date().toISOString(),
      kind: 'heartbeat',
      attempt: null,
      from: null,
      to: null,
      detail: { heartbeat_at: new Date().toISOString() },
    };

    appendJsonLine(journalPath, entry);
    const status = this._regenerateStatus(jobDir);
    this._atomicWriteJsonWithRetry(path.join(jobDir, 'status.json'), status);
  }
}

module.exports = { JobStore };
