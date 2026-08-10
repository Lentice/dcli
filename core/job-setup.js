// One module owns bringing a job into existence. run, resume and submit used
// to each carry this sequence — worktree creation, backend preparation,
// admission acquisition, createJob/createAttemptDir/persistInitFiles, the
// attempt_created and the created→running journal entries — with three copies
// of the release guard, and ticket 90 had to fix that guard twice. The
// commands are argument suppliers now; this module owns the sequence and the
// ownership boundary once.
//
// Setup ownership boundary: every resource acquired below (the worktree and
// the admission slot) is either handed to the caller on the returned handle,
// or released by this guard before rethrowing. A failure in
// createJob/createAttemptDir/persistInitFiles used to exit without either,
// stranding the worktree and burning the durable slot until reconciliation.
const crypto = require('crypto');
const path = require('path');
const { generateJobId } = require('./job-id');
const { prepareBackend } = require('./commands/attempt');
const { resolveHardTimeoutMs } = require('./deadlines');
const { createDetachedWorktree, removeWorktree } = require('./worktree');
const { persistInitFiles } = require('./result-artifact');
const { workerIdentityDetail } = require('./process-identity');

/**
 * Create a job and its first attempt inside one ownership boundary.
 *
 * The caller supplies everything that genuinely varies: the request payload,
 * the prompt, and the three command-specific options (`lineage`, `seedCommit`,
 * `admission`, `durableIdentity`, `journalLaunch`). This module owns the
 * ordering and the release-on-failure guard; on success the caller owns the
 * returned handle's resources until it hands them on (driveAttempt owns them
 * after the handoff) or calls `release()`.
 *
 * `mode` is already effective — the value the job record must carry
 * ('implement' | 'run' | 'submit') — and `request.canonicalDir` is upgraded to
 * the worktree path when an implement-mode worktree is created.
 *
 * @param {Object}   a
 * @param {Object}   a.store
 * @param {Object}   a.adapter
 * @param {Object}   a.request            PrepareInvocation payload
 * @param {string}   a.prompt
 * @param {string}   a.repoKey
 * @param {string}   a.repoRoot
 * @param {string}   a.mode              'implement' | 'run' | 'submit'
 * @param {string}   a.access
 * @param {string|null} a.group
 * @param {string|null} a.label
 * @param {string|null} a.model
 * @param {number|null} a.hardTimeoutSec
 * @param {string|null} a.stateRoot      required for implement mode
 * @param {{ parentJobId:string, sessionStrategy:string, rootJobId:string }|null} [a.lineage]
 * @param {string|null} [a.seedCommit]   resume: fork_from_artifacts base ref
 * @param {Object|null} [a.admission]    null when the caller defers acquisition
 *                                       (submit — the detached worker owns the
 *                                       slot)
 * @param {string}   [a.commandMode]     mode recorded in command.json when it
 *                                       differs from the job mode (submit: 'run')
 * @param {number|null} [a.hardTimeoutMs] explicit command.json hard timeout;
 *                                       default resolveHardTimeoutMs(hardTimeoutSec)
 * @param {{ executionToken:string }|null} [a.durableIdentity] token when the
 *                                       caller mints it (submit)
 * @param {boolean}  [a.journalLaunch]   false when the detached worker journals
 *                                       the attempt launch instead (submit)
 * @returns {{ jobId:string, attemptNum:number, backend:string,
 *             backendVersion:string, adapterVersion:string,
 *             worktree:string|null, worktreeBaseCommit:string|null,
 *             acquiredSlotId:string|null, release:function():void }}
 */
function openAttempt({
  store, adapter, request, prompt,
  repoKey, repoRoot, mode, access, group, label, model, hardTimeoutSec, stateRoot,
  lineage = null, seedCommit = null, admission = null,
  commandMode = mode,
  hardTimeoutMs = null,
  durableIdentity = null,
  journalLaunch = true,
}) {
  const jobId = generateJobId();
  const isoNow = new Date().toISOString();
  const effectiveAccess = access || 'read-only';

  let worktreePath = null;
  let worktreeBaseCommit = null;
  let worktreeCreated = false;
  let canonicalDir = repoRoot;
  if (mode === 'implement') {
    if (!stateRoot) {
      const err = new Error('implement mode requires a state root');
      err.exitCode = 2;
      throw err;
    }
    worktreePath = path.join(stateRoot, 'worktrees', jobId);
    const wt = createDetachedWorktree(repoRoot, worktreePath, undefined, stateRoot, seedCommit);
    worktreeCreated = true;
    worktreeBaseCommit = wt.baseCommit;
    canonicalDir = worktreePath;
  }
  // The request is the payload the adapter runs on; its canonicalDir must name
  // the directory the attempt actually executes inside.
  request.canonicalDir = canonicalDir;

  let acquiredSlotId = null;
  try {
    const { manifest, backend, backendVersion, adapterVersion } = prepareBackend({ adapter, request });

    if (admission) {
      const result = admission.acquireSlot(backend);
      if (!result.acquired) {
        const err = new Error(`System at capacity (global: ${result.active}/${result.limit}). Try again later or use "submit" instead.`);
        err.exitCode = 14;
        throw err;
      }
      acquiredSlotId = result.slotId;
    }

    store.createJob({
      jobId, repoKey, repoRoot,
      backend,
      backendVersion,
      adapterVersion,
      mode,
      access: effectiveAccess,
      group, label, model,
      hardTimeoutSec,
      capabilitiesSnapshot: manifest,
      parentJobId: lineage ? lineage.parentJobId : null,
      rootJobId: lineage ? lineage.rootJobId : null,
      sessionStrategy: lineage ? lineage.sessionStrategy : null,
    });

    const attemptNum = 1;
    store.createAttemptDir({ repoKey, jobId, attemptNum });
    persistInitFiles({
      store, repoKey, jobId, attemptNum, prompt,
      commandParams: {
        model,
        access: effectiveAccess,
        mode: commandMode,
        hardTimeoutMs: hardTimeoutMs !== null ? hardTimeoutMs : resolveHardTimeoutMs(hardTimeoutSec),
        reasoningEffort: request.reasoningEffort,
        variant: request.variant,
        effort: request.effort,
      },
    });

    if (journalLaunch) {
      store.journalTransition(jobId, repoKey, {
        kind: 'attempt_created',
        attempt: attemptNum,
        from: null,
        to: 'created',
        detail: {
          attempt_id: `attempt-${attemptNum}`,
          execution_token: (durableIdentity && durableIdentity.executionToken) || 'tok-' + crypto.randomBytes(16).toString('hex'),
        },
      });

      store.journalTransition(jobId, repoKey, {
        kind: 'attempt_state_changed',
        attempt: attemptNum,
        from: 'created',
        to: 'running',
        detail: {
          started_at: isoNow,
          phase: 'agent_running',
          ...(lineage && lineage.sessionStrategy ? { session_strategy: lineage.sessionStrategy } : {}),
          // A foreground run owns the job too: without its identity a Ctrl-C'd
          // or crashed `run` leaves the record `running` with nothing able to
          // prove otherwise.
          ...workerIdentityDetail({ durable: false }),
          ...(worktreePath ? { worktree_path: worktreePath, worktree_base_commit: worktreeBaseCommit } : {}),
        },
      });
    }

    return {
      jobId,
      attemptNum,
      backend,
      backendVersion,
      adapterVersion,
      worktree: worktreePath,
      worktreeBaseCommit,
      acquiredSlotId,
      // Escape hatch for a failure AFTER setup succeeded and before the caller
      // hands the resources on; idempotent so a double call is a no-op. After
      // the handoff, driveAttempt owns the worktree and the slot.
      release: () => {
        if (worktreeCreated && worktreePath) {
          removeWorktree(repoRoot, worktreePath);
          worktreeCreated = false;
        }
        if (admission && acquiredSlotId) {
          admission.releaseSlot(acquiredSlotId);
          acquiredSlotId = null;
        }
      },
    };
  } catch (err) {
    if (worktreeCreated && worktreePath) removeWorktree(repoRoot, worktreePath);
    if (admission && acquiredSlotId) admission.releaseSlot(acquiredSlotId);
    throw err;
  }
}

module.exports = { openAttempt };
