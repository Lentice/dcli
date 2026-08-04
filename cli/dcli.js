#!/usr/bin/env node
const path = require('path');
const { DEFAULTS } = require('../core/deadlines');

const HARD_TIMEOUT_SEC = DEFAULTS.JOB_HARD_TIMEOUT_MS / 1000;
const WAIT_TIMEOUT_SEC = DEFAULTS.WAIT_TIMEOUT_MS / 1000;
const LIVE_SMOKE_TIMEOUT_SEC = DEFAULTS.DOCTOR_LIVE_SMOKE_MS / 1000;

const help = `dcli — delegate work to a coding-agent CLI

Usage:
  dcli --backend <name> <command> [options]

Commands:
  run       Run a prompt synchronously
  submit    Submit a background job
  status    Show job status
  wait      Wait for a job to complete
  read      Read a terminal job's result
  list      List jobs
  resume    Resume a completed job (--kind: continue_backend_session | fork_from_artifacts | retry_attempt)
  cancel    Cancel a job
  review    Run a code review
  tail      Show tail of job logs
  debug     Compact job diagnosis
  diff      Show diff of an implement-mode job
  apply     Apply changes from an implement-mode job to the main repository
  cleanup   Remove aged terminal jobs and worktree artifacts
  capabilities  Show effective capability manifest
  doctor    Run system and backend health checks

Skill slash command -> CLI subcommand:
  dcli-<b>:jobs       -> dcli --backend <b> list
  dcli-<b>:ask        -> dcli --backend <b> run
  dcli-<b>:implement  -> dcli --backend <b> run --mode implement
  dcli-<b>:review     -> dcli --backend <b> review
  dcli-<b>:resume     -> dcli --backend <b> resume
  dcli-<b>:doctor     -> dcli --backend <b> doctor
  dcli-<b>:cleanup    -> dcli --backend <b> cleanup

Canonical recipe — one synchronous run, both budgets set:
  dcli --backend <name> run --repo <path> --prompt-file <file> \\
    --hard-timeout-sec 900 --timeout-sec 900 --label <label>
The calling tool's own timeout must be longer than --hard-timeout-sec.

Options:
  --help                    Show this message
  --backend <name>          Backend to use (opencode, codex, claude, fake)
  --repo <path>             Repository path
  --prompt-file <path>      Read prompt from file (canonical way to supply a follow-up prompt for resume)
  --hard-timeout-sec <n>    Job hard timeout in seconds (default: ${HARD_TIMEOUT_SEC})
  --group <g>               Job group label
  --label <l>               Job label
  --model <id>              Model identifier
  --json                    JSON output envelope
  --timeout-sec <n>         Wait timeout in seconds (default: ${WAIT_TIMEOUT_SEC})
  --all                     Wait for all matching jobs
  --older-than <Nd|Nh>      Retention threshold (positive days or hours)
  --dry-run                 Preview cleanup without deleting
  --scrub-session-ids       Blank recorded backend session ids
  --max-bytes <n>           Maximum bytes for tail (default: 4096)
  --kind <s>                Resume kind: continue_backend_session, fork_from_artifacts, retry_attempt
  --reasoning-effort <s>    Reasoning effort level (backend-specific)
  --variant <s>             opencode-specific reasoning variant
  --effort <s>              Codex/Claude effort level
  --access <s>              Access mode: read-only (default), workspace, full
  --mode <s>                run mode: run (default), implement (worktree-isolated)
  --live-smoke-timeout-sec <n>  Doctor live smoke timeout in seconds (default: ${LIVE_SMOKE_TIMEOUT_SEC})
  --staged                      Review staged changes (git diff --staged)
  --working                     Review working tree changes (default)
  --range <base>..<head>        Review changes between base and head
  --path <p>                    Limit to specific path(s) (repeatable)
  --include-untracked           Include untracked files in review
  --embed-diff                  Embed the diff in the prompt (default)
  --intent <s>                  One-line description of review intent
  --focus <s>                   Specific aspect to focus on
  --stat                        Show diffstat (diff command)
  --name-only                   Show filenames only (diff command)
  --reset-author                Reauthor the landed commit (apply command)
  --message <s>                 Retitle the landed commit (apply command)
  --allow-untracked             Allow unrelated untracked files in working tree (apply command)

Every recipe with a wait should set both --timeout-sec and --hard-timeout-sec.
When --timeout-sec is omitted, wait uses ${WAIT_TIMEOUT_SEC}s for the caller-side budget;
this never changes the job hard timeout. JSON wait output includes wait_timed_out and
wait_timeout_sec so a caller can distinguish its own deadline from the job state.

Backends:
  fake      Test double (used for development and testing dcli itself)
  opencode  opencode serve per job over HTTP
  codex     codex exec --json, prompt on stdin
  claude    claude -p --output-format stream-json

Each backend has its own shim: dcli-opencode, dcli-codex, dcli-claude.
`;

if (process.argv.includes('--help')) {
  console.log(help);
  process.exit(0);
}

const { parseArgs, buildEnvelope, resolvePrompt, maybeAccessHint } = require('../core/commands/index');
const { JobStore } = require('../core/job-store');
const { getStateRoot, ensureStateRoot } = require('../core/state-root');
const { computeRepoKeyWithPath } = require('../core/repo-key');
const { Redactor } = require('../core/redactor');
const { setRedactor } = require('../core/fs-text');
const { AdmissionController } = require('../core/admission');
const { getBackground, getBackendLimits, DEFAULT_BACKEND } = require('../adapters/registry');

async function main() {
  const parsed = parseArgs(process.argv);

  if (parsed.help) {
    console.log(help);
    process.exit(0);
  }

  if (!parsed.command) {
    console.error('Usage: dcli --backend <name> <command> [options]');
    console.error('Run dcli --help for details.');
    process.exit(2);
  }

  const backend = parsed.backend || DEFAULT_BACKEND;

  let adapter;
  try {
    const adapterPath = path.resolve(__dirname, '..', 'adapters', backend, 'adapter');
    const bg = getBackground(backend);
    const mod = require(adapterPath);
    const AdapterClass = mod[bg.class];
    if (!AdapterClass) throw new Error(`Adapter module for "${backend}" does not export class ${bg.class}`);
    adapter = new AdapterClass();
  } catch (err) {
    console.error(`Failed to load adapter "${backend}": ${err.message}`);
    process.exit(12);
  }

  // State placement is independent of repository resolution: the OS user-space
  // root, never inside the repo. Deriving it from --repo made the root differ
  // between invocations of the same job — `run --repo X` wrote to X\.dcli-state
  // while a later `status <id>` without --repo read the user-space root and
  // reported "Job not found". Jobs are already namespaced by repo_key inside
  // the root, so the per-repo directory bought nothing.
  const stateRoot = process.env.DCLI_STATE_ROOT
    || (process.env.NODE_ENV === 'test' ? process.env.DCLI_TEST_STATE_ROOT : null)
    || getStateRoot();

  ensureStateRoot(stateRoot);

  const redactor = new Redactor();
  setRedactor(redactor);

  const admissionController = new AdmissionController({
    stateRoot,
    backendLimits: getBackendLimits(),
  });
  admissionController.reconcile();

  const store = new JobStore({ stateRoot });

  const repoPath = parsed.repo || process.cwd();
  const { repoKey, fullPath } = computeRepoKeyWithPath(repoPath);

  switch (parsed.command) {
    case 'run': {
      const { executeRun } = require('../core/commands/run');
      // isTTY is undefined/false in many legitimate non-interactive contexts
      // that never actually pipe data (this project's primary caller, Claude
      // Code's own tool-invoked shell, is one) -- so !isTTY alone is not a
      // reliable "stdin is piped" signal. An explicit positional prompt or
      // --prompt-file is unambiguous and must never be silently overridden
      // by an indefinite/empty stdin read in that case.
      const stdinPipeActive = !process.stdin.isTTY && parsed.positionals.length === 0 && !parsed.promptFile;
      const prompt = await resolvePrompt({
        promptFile: parsed.promptFile,
        stdinPipeActive,
        positionals: parsed.positionals,
      });

      const accessHint = maybeAccessHint({ access: parsed.access, prompt });
      if (accessHint && !parsed.json) process.stderr.write(accessHint + '\n');

      const output = await executeRun({
        store, adapter, repoKey, repoRoot: fullPath,
        prompt,
        hardTimeoutSec: parsed.hardTimeoutSec,
        group: parsed.group, label: parsed.label, model: parsed.model,
        access: parsed.access,
        reasoningEffort: parsed.reasoningEffort,
        variant: parsed.variant,
        effort: parsed.effort,
        admission: admissionController,
        mode: parsed.mode || 'run',
        stateRoot,
      });

      if (parsed.json) {
        console.log(JSON.stringify(output.envelope));
      } else {
        console.log(output.text);
      }
      process.exit(output.exitCode || 0);
    }

    case 'submit': {
      const { executeSubmit } = require('../core/commands/submit');
      // isTTY is undefined/false in many legitimate non-interactive contexts
      // that never actually pipe data (this project's primary caller, Claude
      // Code's own tool-invoked shell, is one) -- so !isTTY alone is not a
      // reliable "stdin is piped" signal. An explicit positional prompt or
      // --prompt-file is unambiguous and must never be silently overridden
      // by an indefinite/empty stdin read in that case.
      const stdinPipeActive = !process.stdin.isTTY && parsed.positionals.length === 0 && !parsed.promptFile;
      const prompt = await resolvePrompt({
        promptFile: parsed.promptFile,
        stdinPipeActive,
        positionals: parsed.positionals,
      });

      const output = await executeSubmit({
        store, adapter, repoKey, repoRoot: fullPath,
        prompt,
        hardTimeoutSec: parsed.hardTimeoutSec,
        group: parsed.group, label: parsed.label, model: parsed.model,
        access: parsed.access,
        reasoningEffort: parsed.reasoningEffort,
        variant: parsed.variant,
        effort: parsed.effort,
        admission: admissionController,
        resumeJobId: parsed.resume || null,
        stateRoot,
        backend,
      });

      if (parsed.json) {
        const status = store.readStatus({ repoKey, jobId: output.jobId });
        console.log(JSON.stringify(buildEnvelope(status)));
      } else {
        console.log(output.jobId);
      }
      process.exit(0);
    }

    case 'status': {
      const { executeStatus } = require('../core/commands/status');
      const jobId = parsed.positionals[0];
      if (!jobId) {
        console.error('status requires a job ID');
        process.exit(2);
      }

      const result = await executeStatus({ store, repoKey, jobId });

      if (parsed.json) {
        console.log(JSON.stringify(result.envelope));
      } else {
        console.log(`Job: ${result.status.job_id}`);
        console.log(`State: ${result.status.state}`);
        console.log(`Phase: ${result.status.phase || 'none'}`);
        console.log(`Backend: ${result.status.backend || 'unknown'}`);
      }
      process.exit(0);
    }

    case 'wait': {
      const { buildWaitJson, executeWait, executeWaitAll } = require('../core/commands/wait');

      if (parsed.waitAll) {
        const result = await executeWaitAll({
          store, repoKey, group: parsed.group,
          timeoutSec: parsed.timeoutSec,
        });

        for (const err of result.errors || []) {
          process.stderr.write(`warning: could not read job record — ${err}\n`);
        }

        if (parsed.json) {
          console.log(JSON.stringify(buildWaitJson(result)));
        } else {
          for (const j of result.jobs) {
            // Print what executeWaitAll actually returns. It reports state and
            // phase; `timed_out`/`exit_code` were never fields on these rows,
            // so every line read "<undefined>: done (exit undefined)".
            console.log(`${j.job_id}: ${j.state}${j.phase ? ` (${j.phase})` : ''}`);
          }
          if (result.timedOut) {
            console.log(`Wait budget elapsed after ${result.waitTimeoutSec}s; active jobs may still be running.`);
          }
        }
        process.exit(result.exitCode);
      }

      const jobId = parsed.positionals[0];
      if (!jobId) {
        console.error('wait requires a job ID');
        process.exit(2);
      }

      const result = await executeWait({
        store, repoKey, jobId,
        timeoutSec: parsed.timeoutSec,
      });

      if (parsed.json) {
        console.log(JSON.stringify(buildWaitJson(result)));
      } else if (result.timedOut) {
        console.log(`Wait budget elapsed after ${result.waitTimeoutSec}s; job ${jobId} is still active`);
      } else {
        console.log(`Job ${jobId} is ${result.envelope.state}`);
      }
      process.exit(result.exitCode);
    }

    case 'read': {
      const { executeRead } = require('../core/commands/read');
      const jobId = parsed.positionals[0];
      if (!jobId) {
        console.error('read requires a job ID');
        process.exit(2);
      }

      const result = await executeRead({ store, repoKey, jobId });

      if (!result.isTerminal) {
        if (parsed.json) {
          console.log(JSON.stringify(result.envelope));
        } else {
          console.log(`Job ${jobId} is not terminal (state: ${result.envelope.state})`);
        }
        process.exit(4);
      }

      if (parsed.json) {
        console.log(JSON.stringify(result.envelope));
      } else {
        console.log(result.text || '');
      }
      process.exit(result.exitCode);
    }

    case 'resume': {
      const { executeResume } = require('../core/commands/resume');

      const parentJobId = parsed.positionals[0];
      if (!parentJobId) {
        console.error('resume requires a parent job ID');
        process.exit(2);
      }

      const followupPositionals = parsed.positionals.slice(1);
      const stdinPipeActive = !process.stdin.isTTY && followupPositionals.length === 0 && !parsed.promptFile;
      const prompt = await resolvePrompt({
        promptFile: parsed.promptFile,
        stdinPipeActive,
        positionals: followupPositionals,
      });

      const accessHint = maybeAccessHint({ access: parsed.access, prompt });
      if (accessHint && !parsed.json) process.stderr.write(accessHint + '\n');

      const output = await executeResume({
        store, adapter, repoKey, repoRoot: fullPath,
        prompt,
        kind: parsed.kind,
        hardTimeoutSec: parsed.hardTimeoutSec,
        group: parsed.group, label: parsed.label, model: parsed.model,
        access: parsed.access,
        reasoningEffort: parsed.reasoningEffort,
        variant: parsed.variant,
        effort: parsed.effort,
        admission: admissionController,
        mode: parsed.mode || 'run',
        stateRoot,
        parentJobId,
      });

      if (parsed.json) {
        console.log(JSON.stringify(output.envelope));
      } else {
        console.log(output.text || '');
      }
      process.exit(output.exitCode || 0);
    }

    case 'list': {
      const { executeList } = require('../core/commands/list');
      const result = await executeList({ store, repoKey, groupFilter: parsed.group });

      // A record that could not be read is not a job that is not there. Say so
      // on stderr rather than returning a quietly shorter list.
      for (const err of result.errors || []) {
        process.stderr.write(`warning: could not read job record — ${err}\n`);
      }

      if (parsed.json) {
        console.log(JSON.stringify({ schema_version: 1, jobs: result.jobs, errors: result.errors || [] }));
      } else {
        if (result.jobs.length === 0) {
          // "No jobs found" is a claim about what exists. It cannot be made
          // when every record we looked at was unreadable.
          console.log((result.errors || []).length > 0
            ? `No readable jobs (${result.errors.length} record(s) could not be read).`
            : 'No jobs found.');
        } else {
          for (const j of result.jobs) {
            const line = `${j.job_id}  ${j.state.padEnd(12)} ${j.backend || '?'}  ${j.created_at || ''}`;
            console.log(line);
          }
        }
      }
      process.exit(result.exitCode || 0);
    }

    case 'review': {
      const { executeReview } = require('../core/commands/review');

      const stdinPipeActive = !process.stdin.isTTY && parsed.positionals.length === 0 && !parsed.promptFile;
      const prompt = await resolvePrompt({
        promptFile: parsed.promptFile,
        stdinPipeActive,
        positionals: parsed.positionals,
      });

      if (parsed.access && parsed.access !== 'read-only') {
        console.error('--access must be "read-only" for review. Got: ' + parsed.access);
        process.exit(2);
      }

      let reviewScope = 'working';
      if (parsed.staged && parsed.working) {
        console.error('Cannot specify both --staged and --working');
        process.exit(2);
      }
      if (parsed.staged) reviewScope = 'staged';
      if (parsed.range) reviewScope = 'range';

      let rangeBase = null;
      let rangeHead = null;
      if (parsed.range) {
        const parts = parsed.range.split('..');
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          console.error('--range must be in format <base>..<head>');
          process.exit(2);
        }
        rangeBase = parts[0];
        rangeHead = parts[1];
      }

      const output = await executeReview({
        store, adapter, repoKey, repoRoot: fullPath,
        prompt,
        hardTimeoutSec: parsed.hardTimeoutSec,
        group: parsed.group, label: parsed.label, model: parsed.model,
        access: 'read-only',
        reasoningEffort: parsed.reasoningEffort,
        variant: parsed.variant,
        effort: parsed.effort,
        admission: admissionController,
        reviewScope,
        rangeBase,
        rangeHead,
        paths: parsed.paths || null,
        includeUntracked: parsed.includeUntracked || false,
        embedDiff: parsed.embedDiff !== false,
        intent: parsed.intent || null,
        focus: parsed.focus || null,
      });

      if (parsed.json) {
        console.log(JSON.stringify(output.envelope));
      } else {
        if (output.text) console.log(output.text);
        if (output.findings) {
          console.log(`\nFindings: ${output.findings.status}`);
          if (output.findings.error) console.log(`Findings error: ${output.findings.error}`);
        }
      }
      process.exit(output.exitCode || 0);
    }

    case 'tail': {
      const { executeTail } = require('../core/commands/tail');
      const jobId = parsed.positionals[0];
      if (!jobId) {
        console.error('tail requires a job ID');
        process.exit(2);
      }

      const result = await executeTail({
        store, repoKey, jobId,
        maxBytes: parsed.maxBytes,
      });

      if (result.worker) {
        console.log(`=== worker.log (${result.worker.totalBytes} bytes, showing ${result.worker.returnedBytes}) ===`);
        console.log(result.worker.content);
      }
      if (result.backendEvents) {
        console.log(`=== backend-events.jsonl (${result.backendEvents.totalBytes} bytes, showing ${result.backendEvents.returnedBytes}) ===`);
        console.log(result.backendEvents.content);
      }
      if (!result.worker && !result.backendEvents) {
        console.log('(no log files found)');
      }
      process.exit(0);
    }

    case 'debug': {
      const { executeDebug } = require('../core/commands/debug');
      const jobId = parsed.positionals[0];
      if (!jobId) {
        console.error('debug requires a job ID');
        process.exit(2);
      }

      const report = await executeDebug({ store, repoKey, jobId });

      console.log(`Job: ${report.job_id}`);
      console.log(`State: ${report.state}  Phase: ${report.phase || '-'}  Attempt: ${report.attempt}`);
      if (report.warning) {
        console.log(`[WARNING: ${report.warning}]`);
      }
      if (report.worker) {
        const alive = report.worker.alive === true ? 'yes' : report.worker.alive === false ? 'no' : 'unknown';
        console.log(`Worker: pid=${report.worker.pid} identity=${report.worker.identity || '-'} alive=${alive}`);
      }
      if (report.containment) {
        console.log(`Containment: kind=${report.containment.kind || '-'} degraded=${report.containment.degraded}`);
      }
      console.log(`Backend: ${report.backend || '-'}`);
      console.log(`Timings: created=${report.timings.created_at || '-'} started=${report.timings.started_at || '-'} heartbeat=${report.timings.heartbeat_at || '-'} finished=${report.timings.finished_at || '-'}`);
      console.log(`Result: present=${report.result.present} bytes=${report.result.bytes} findings=${report.result.findings_status || '-'}`);
      if (report.stderr) {
        console.log(`Stderr (last ${report.stderr.returnedBytes} bytes${report.stderr.truncated ? ', truncated' : ''}):`);
        console.log(report.stderr.content);
      }
      process.exit(0);
    }

    case 'cleanup': {
      const { executeCleanup } = require('../core/commands/cleanup');
      const result = await executeCleanup({
        store,
        olderThan: parsed.olderThan,
        dryRun: parsed.dryRun,
        scrubSessionIds: parsed.scrubSessionIds,
      });
      const worktreeBytes = result.worktrees.reduce((sum, worktree) => sum + worktree.bytes, 0);

      if (result.errors.length > 0) {
        for (const err of result.errors) {
          console.error(`Error: ${err}`);
        }
      }

      if (result.dryRun) {
        console.log(`Dry-run: would remove ${result.removed} jobs and ${result.worktrees.length} worktrees (${worktreeBytes} bytes)`);
        if (result.scrubbed > 0) console.log(`  would scrub ${result.scrubbed} session ids`);
      } else {
        console.log(`Cleanup: ${result.removed} removed, ${result.skipped} skipped, ${result.worktrees.length} worktrees removed (${worktreeBytes} bytes), ${result.scrubbed} scrubbed`);
      }
      for (const worktree of result.worktrees) {
        console.log(`  worktree: ${worktree.path} (${worktree.bytes} bytes${worktree.orphan ? ', orphan' : ''})`);
      }
      for (const item of result.skippedItems) {
        console.log(`  skipped: ${item.name}${item.path ? ` (${item.path})` : ''} — ${item.reason}`);
      }
      process.exit(0);
    }

    case 'capabilities': {
      const { executeCapabilities } = require('../core/commands/capabilities');
      const result = await executeCapabilities({ adapter, json: parsed.json });
      console.log(JSON.stringify(result.manifest, null, 2));
      process.exit(0);
    }

    case 'diff': {
      const { executeDiff } = require('../core/commands/diff');
      const jobId = parsed.positionals[0];
      if (!jobId) {
        console.error('diff requires a job ID');
        process.exit(2);
      }

      const result = executeDiff({
        store, repoKey, jobId,
        stat: parsed.stat || false,
        nameOnly: parsed.nameOnly || false,
      });

      if (parsed.json) {
        console.log(JSON.stringify({ text: result.text, exit_code: result.exitCode }));
      } else {
        console.log(result.text);
      }
      process.exit(result.exitCode);
    }

    case 'apply': {
      const { executeApply } = require('../core/commands/apply');
      const jobId = parsed.positionals[0];
      if (!jobId) {
        console.error('apply requires a job ID');
        process.exit(2);
      }

      const result = executeApply({
        store, repoKey, jobId,
        resetAuthor: parsed.resetAuthor || false,
        message: parsed.message || null,
        allowUntracked: parsed.allowUntracked || false,
      });

      if (parsed.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(`Applied. Landed commit: ${result.landedCommit}`);
      }
      process.exit(result.exitCode);
    }

    case 'cancel': {
      const { executeCancel } = require('../core/commands/cancel');
      const jobId = parsed.positionals[0];
      if (!jobId) {
        console.error('cancel requires a job ID');
        process.exit(2);
      }

      const result = await executeCancel({
        store, adapter, repoKey, jobId,
        json: parsed.json,
      });

      if (parsed.json) {
        console.log(JSON.stringify(result.envelope));
      } else if (result.warning) {
        console.log(`Cancel ${result.warning} (state: ${result.state})`);
      } else {
        console.log(`Job ${jobId} is ${result.state}`);
      }
      process.exit(result.exitCode);
    }

    case 'doctor': {
      const { executeDoctor } = require('../core/commands/doctor');
      const result = await executeDoctor({
        adapter,
        stateRoot,
        repoPath: repoPath,
        json: parsed.json,
        liveSmokeTimeoutSec: parsed.liveSmokeTimeoutSec,
      });
      console.log(JSON.stringify(result.envelope, null, 2));
      process.exit(0);
    }

    default: {
      console.error(`Unknown command: ${parsed.command}`);
      process.exit(2);
    }
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(err.exitCode || 1);
});
