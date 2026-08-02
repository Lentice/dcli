const fs = require('fs');
const path = require('path');
const { writeTextFileAtomic, writeJsonFileAtomic, appendJsonLine } = require('./fs-text');
const { maybeInject } = require('./inject-points');
const { reduce, TERMINAL } = require('./reducer');
const { isProcessAlive, isSameProcessAlive, parseWorkerIdentity } = require('./process-identity');
const { LockManager, LOCK_SCOPES } = require('./locking');

const ATOMIC_WRITE_MAX_RETRIES = 10;
const ATOMIC_WRITE_DELAY_MS = 20;

class JobStore {
  constructor({ stateRoot }) {
    this._stateRoot = stateRoot;
    this._jobsDir = path.join(stateRoot, 'jobs');
    this._jobLocks = new LockManager({ lockDir: path.join(stateRoot, 'locks') });
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
      kill_skipped: null,
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
        let preserveTerminal = false;
        if (entry.to != null) {
          // Terminal states are monotonic. A late cancel or duplicate worker
          // publication must not rewrite an already published result.
          preserveTerminal = TERMINAL.has(updated.state) && TERMINAL.has(entry.to) &&
            updated.state !== entry.to && updated.state !== 'interrupted';
          // Don't let done/failed overwrite a confirmed cancelled or timed_out
          if (['cancelled', 'timed_out'].includes(updated.state) &&
              ['done', 'failed'].includes(entry.to)) {
            preserveTerminal = true;
          }
          if (TERMINAL.has(updated.state) && !TERMINAL.has(entry.to)) {
            preserveTerminal = true;
          }
          if (!preserveTerminal) {
            updated.state = entry.to;
            updated.attempt_state = entry.to;
          } else if ((entry.detail || {}).reconciled) {
            // A reconciliation entry that lost the race loses its detail too.
            // Reconciliation infers an outcome from the outside, with no
            // coordination against the worker publishing its real one, so
            // applying its detail anyway stamped a completed job with
            // failure_reason 'worker_lost' and a later finished_at — done and
            // failed at once. A deliberate producer-written correction (a
            // second transition refining exit codes) still applies; only the
            // inferred one is discarded.
            return updated;
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
        // Append-only addition: records why a hard timeout did not escalate to a
        // contained tree kill (e.g. 'not_contained'). Without it a timed_out job is
        // indistinguishable from one whose backend tree was provably killed.
        if (d.kill_skipped !== undefined) updated.kill_skipped = d.kill_skipped;
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
    // Whether the file ends in a newline is the ONLY evidence distinguishing a
    // torn append from a fully written record that is corrupt, and trimming
    // first destroys it. Without this check a corrupted terminal transition was
    // silently dropped and replaced by inferred state.
    const tornTail = content.length > 0 && !content.endsWith('\n');
    const lines = content.trim().split('\n').filter(l => l.length > 0);
    return lines.map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        // A worker killed mid-append leaves a partial LAST line with no
        // terminating newline. Dropping that costs one un-journaled
        // transition; refusing to parse the file makes every command on the
        // job fail with "record could not be read" forever — exactly when the
        // user is trying to find out what happened. Anything else is real
        // corruption and still throws.
        if (tornTail && i === lines.length - 1) return null;
        throw err;
      }
    }).filter(Boolean);
  }

  _regenerateStatusFromEntries(entries, { backstop = true } = {}) {
    let status = this._defaultStatus();
    for (const entry of entries) {
      status = this._applyJournalEntry(status, entry);
    }
    if (backstop) status = this._applyReducerBackstop(status, entries);
    return status;
  }

  _regenerateStatus(jobDir, options) {
    const entries = this._readRawJournal(jobDir);
    return this._regenerateStatusFromEntries(entries, options);
  }

  _applyReducerBackstop(status, entries) {
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

  /**
   * @param {{ repoKey:string, jobId:string, status?:Object }} args
   *   `status` lets a caller that has already regenerated the projection pass
   *   it in. Re-reading status.json here instead meant evidence could be
   *   gathered from a projection that disagreed with the journal it is derived
   *   from — e.g. an interrupted projection write leaving a stale heartbeat.
   */
  gatherEvidence({ repoKey, jobId, status: providedStatus }) {
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
      sentinelState: null,
    };

    try {
      const status = providedStatus || this.readStatus({ repoKey, jobId });

      // A fresh durable heartbeat is positive liveness evidence. Waiting a
      // short grace period after the last heartbeat avoids spawning a
      // synchronous OS probe on every 200ms wait poll while still probing
      // stale owners before reconciling them.
      const heartbeatAge = status.heartbeat_at
        ? Date.now() - new Date(status.heartbeat_at).getTime()
        : Infinity;
      if (Number.isFinite(heartbeatAge) && heartbeatAge >= 0 && heartbeatAge < 6000) {
        evidence.workerAlive = true;
      }

      // Prefer the recorded identity over the bare pid. A bare pid is
      // creation-time ancestry with no proof of who holds it now, so a reused
      // pid answers "yes, the worker is alive" for a process that is not the
      // worker — and the abandoned job never reaches a terminal state.
      // isSameProcessAlive() only degrades to bare liveness when the recorded
      // start time is not OS-sourced, which is what it is today.
      const identity = parseWorkerIdentity(status.worker_identity);
      if (evidence.workerAlive !== true && identity) {
        try { evidence.workerAlive = isSameProcessAlive(identity); } catch {}
      } else if (status.worker_pid) {
        try { evidence.workerAlive = isProcessAlive(status.worker_pid); } catch {}
      }
      if (status.job_id) evidence.jobId = status.job_id;

      // Check completion sentinel under attempts/<n>/
      const attemptNum = status.attempt;
      if (attemptNum) {
        const sentinelPath = path.join(jobDir, 'attempts', String(attemptNum), 'worker-complete.json');
        if (fs.existsSync(sentinelPath)) {
          try {
            const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
            // Present ONLY if it parses. Marking it present first and then
            // swallowing the parse error turned a half-written file into
            // "the worker completed, with an unknown exit code", which the
            // reducer resolves to `failed`. An unreadable sentinel is not
            // evidence of anything; absent it is, and the job reduces to
            // `interrupted` — which is what actually happened.
            evidence.completionSentinelPresent = true;
            if (sentinel.exit_code !== undefined) evidence.commandExitCode = sentinel.exit_code;
            // The state the worker itself published. An `interrupted` attempt
            // exits 0, so the exit code alone would read as `done`.
            if (typeof sentinel.state === 'string') evidence.sentinelState = sentinel.state;
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
    // Cheap exit before taking the lock: a reader polling every 200ms must not
    // contend with the worker's own heartbeat for the per-job lock.
    const projected = this._regenerateStatus(this._jobDir(repoKey, jobId), { backstop: false });
    if (TERMINAL.has(projected.state)) return projected;

    const evidence = this.gatherEvidence({ repoKey, jobId, status: projected });

    // Reconciliation exists to resolve a job whose OWNER IS GONE. While the
    // worker is observably alive, its outcome is its own to publish, and
    // journaling an inferred one is destructive: terminal states are monotonic,
    // so a `cancelled` inferred from a pending cancel request — by a passing
    // `status`, `wait` or `list`, none of which are cancelling anything — would
    // permanently outrank the `done` the worker was seconds from writing.
    if (evidence.workerAlive === true) return projected;

    const reduced = reduce(projected, [], evidence);
    if (reduced.state === projected.state) return projected;

    // Publishing requires the writer lock, taken non-blockingly so reads stay
    // zero-wait. Everything above was a lock-free preview; the decision that
    // gets WRITTEN must be re-derived under the lock, because a heartbeat or a
    // terminal transition can land between the preview and the acquisition —
    // and an inference from evidence that is already superseded is exactly the
    // kind of stale terminal this whole path exists to avoid.
    const lockKey = `${repoKey}-${jobId}`;
    const lock = this._jobLocks.tryAcquire(LOCK_SCOPES.PER_JOB, lockKey, { operation: 'reconcile' });
    if (!lock) return projected;
    try {
      const fresh = this._regenerateStatus(this._jobDir(repoKey, jobId), { backstop: false });
      if (TERMINAL.has(fresh.state)) return fresh;
      const freshEvidence = this.gatherEvidence({ repoKey, jobId, status: fresh });
      if (freshEvidence.workerAlive === true) return fresh;
      // Publish only on POSITIVE evidence that the owner is gone. A stale
      // heartbeat with unknown liveness is enough to *display* `interrupted`,
      // but not to write it: a job that predates worker-identity recording has
      // no pid to check and only ever wrote one heartbeat, so a passing
      // `status` would have declared every such job interrupted — permanently,
      // since terminal states are monotonic — while its backend ran on.
      if (freshEvidence.workerAlive !== false && !freshEvidence.completionSentinelPresent) return fresh;
      const freshReduced = reduce(fresh, [], freshEvidence);
      if (freshReduced.state === fresh.state) return fresh;
      return this._publishReconciled({ repoKey, jobId, projected: fresh, reduced: freshReduced, evidence: freshEvidence });
    } finally {
      this._jobLocks.release(lock);
    }
  }

  /**
   * Journal a reconciled terminal state. Caller holds the per-job lock; the
   * nested acquire inside journalTransition returns that same handle.
   */
  _publishReconciled({ repoKey, jobId, projected, reduced, evidence }) {

    // The reconciled state is journaled, not written straight to status.json.
    // status.json is a projection of the journal — every read-side command
    // regenerates it — so a direct write is erased by the next replay and the
    // job pops back to `running` on the very next poll.
    const written = this.journalTransition(jobId, repoKey, {
      kind: 'attempt_state_changed',
      attempt: projected.attempt || null,
      from: projected.state,
      to: reduced.state,
      nonBlocking: true,
      detail: {
        finished_at: new Date().toISOString(),
        phase: reduced.phase,
        failure_reason: reduced.failure_reason !== undefined ? reduced.failure_reason : null,
        failure: reduced.failure !== undefined ? reduced.failure : null,
        // Durable producer evidence, not an inference: keep it rather than
        // leaving the append-only field null on a recovered attempt.
        ...(evidence.commandExitCode !== null && evidence.commandExitCode !== undefined
          ? { command_exit_code: evidence.commandExitCode }
          : {}),
        reconciled: true,
      },
    });
    // Never return a terminal state that is not in the journal: list and
    // wait --all would report a completion that the next replay takes back.
    if (!written) return projected;
    return this.readStatus({ repoKey, jobId });
  }

  /**
   * Drop a torn (non-newline-terminated) final record before appending.
   *
   * Tolerating the torn tail on read is not enough: the next append lands
   * directly against those bytes, producing ONE newline-terminated line of
   * concatenated garbage — which is indistinguishable from real corruption and
   * makes the job unreadable forever, permanently. Callers must hold the
   * per-job lock.
   *
   * @param {string} journalPath
   */
  _repairTornTail(journalPath) {
    let content;
    try {
      content = fs.readFileSync(journalPath, 'utf8');
    } catch (err) {
      // No journal yet is normal (the first append creates it). Anything else
      // means we cannot tell whether a torn tail is there, and appending blind
      // is what causes the permanent corruption.
      if (err && err.code === 'ENOENT') return;
      const e = new Error(`Cannot inspect journal before append: ${journalPath}: ${err.message}`);
      e.exitCode = 17;
      throw e;
    }
    if (content.length === 0 || content.endsWith('\n')) return;
    const cut = content.lastIndexOf('\n');
    // A missing trailing newline alone does not make the record garbage — the
    // write may have completed and only the newline been lost. Truncating on
    // that signal alone would delete a valid, durable transition. Only an
    // unparseable tail is torn.
    const tail = content.slice(cut + 1);
    try {
      JSON.parse(tail);
      // Complete record, just unterminated: give it its newline so the next
      // append cannot weld onto it.
      writeTextFileAtomic(journalPath, content + '\n');
      return;
    } catch {}
    writeTextFileAtomic(journalPath, cut === -1 ? '' : content.slice(0, cut + 1));
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

  /**
   * @param {{ kind:string, attempt:number|null, from:string|null, to:string|null,
   *           detail:Object, nonBlocking?:boolean }} args
   *   `nonBlocking` returns null instead of waiting for the writer lock. Read
   *   commands must stay zero-wait (tickets 04/05): they may publish a
   *   reconciled state opportunistically, but never block behind a worker's
   *   heartbeat to do it. A contended lock also means a writer is active, so
   *   skipping is the right answer anyway.
   */
  journalTransition(jobId, repoKey, { kind, attempt, from, to, detail, nonBlocking }) {
    const jobDir = this._jobDir(repoKey, jobId);
    const journalPath = path.join(jobDir, 'journal.jsonl');
    const lockKey = `${repoKey}-${jobId}`;
    const lock = nonBlocking
      ? this._jobLocks.tryAcquire(LOCK_SCOPES.PER_JOB, lockKey, { operation: 'journal' })
      : this._jobLocks.acquire(LOCK_SCOPES.PER_JOB, lockKey, { operation: 'journal' });
    if (!lock) return null;
    try {
      // Inside the try: this throws on an unreadable journal, and a throw
      // before the finally leaks the per-job lock for the life of the process.
      // Not best-effort either — if the torn tail cannot be removed, appending
      // would weld the new record onto the partial one and make the journal
      // permanently unreadable. Failing the write is the recoverable outcome.
      this._repairTornTail(journalPath);
      const entry = {
        seq: this._lastJournalSeq(jobDir) + 1,
        at: new Date().toISOString(),
        kind,
        attempt: attempt || null,
        from: from || null,
        to: to || null,
        detail: detail || {},
      };

      appendJsonLine(journalPath, entry);

      maybeInject('journal-before-status-write');

      const status = this._regenerateStatus(jobDir, { backstop: false });
      this._atomicWriteJsonWithRetry(path.join(jobDir, 'status.json'), status);
      return entry;
    } finally {
      this._jobLocks.release(lock);
    }
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
    const lock = this._jobLocks.acquire(LOCK_SCOPES.PER_JOB, `${repoKey}-${jobId}`, { operation: 'heartbeat' });
    try {
      // Inside the try — see journalTransition: throwing before the finally
      // leaks the lock.
      this._repairTornTail(journalPath);
      const now = new Date().toISOString();
      const entry = {
        seq: this._lastJournalSeq(jobDir) + 1,
        at: now,
        kind: 'heartbeat',
        attempt: null,
        from: null,
        to: null,
        detail: { heartbeat_at: now },
      };

      appendJsonLine(journalPath, entry);
      const status = this._regenerateStatus(jobDir, { backstop: false });
      this._atomicWriteJsonWithRetry(path.join(jobDir, 'status.json'), status);
    } finally {
      this._jobLocks.release(lock);
    }
  }
}

module.exports = { JobStore };
