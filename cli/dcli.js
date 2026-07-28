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
  cancel    Cancel a job
  review    Run a code review
  tail      Show tail of job logs
  debug     Compact job diagnosis
  cleanup   Remove aged terminal jobs
  capabilities  Show effective capability manifest
  doctor    Run system and backend health checks

Options:
  --help                    Show this message
  --backend <name>          Backend to use (opencode, codex, claude, fake)
  --repo <path>             Repository path
  --prompt-file <path>      Read prompt from file
  --hard-timeout-sec <n>    Job hard timeout in seconds (default: 1800)
  --group <g>               Job group label
  --label <l>               Job label
  --model <id>              Model identifier
  --json                    JSON output envelope
  --timeout-sec <n>         Wait timeout in seconds
  --all                     Wait for all matching jobs
  --older-than <Nd|Nh>      Retention threshold for cleanup
  --dry-run                 Preview cleanup without deleting
  --scrub-session-ids       Blank recorded backend session ids
  --max-bytes <n>           Maximum bytes for tail (default: 4096)
  --reasoning-effort <s>    Reasoning effort level (backend-specific)
  --variant <s>             opencode-specific reasoning variant
  --effort <s>              Codex/Claude effort level
  --access <s>              Access mode: read-only (default), workspace, full
  --live-smoke-timeout-sec <n>  Doctor live smoke timeout in seconds (default: 120)
  --staged                      Review staged changes (git diff --staged)
  --working                     Review working tree changes (default)
  --range <base>..<head>        Review changes between base and head
  --path <p>                    Limit to specific path(s) (repeatable)
  --include-untracked           Include untracked files in review
  --embed-diff                  Embed the diff in the prompt (default)
  --intent <s>                  One-line description of review intent
  --focus <s>                   Specific aspect to focus on

Every recipe with a wait carries an explicit budget: set --timeout-sec and --hard-timeout-sec.

Backends:
  fake      Test double (used for development and testing)
  opencode  opencode serve per job over HTTP
  codex     codex exec --json, prompt on stdin
  claude    claude -p --output-format stream-json

Each backend has its own shim: dcli-opencode, dcli-codex, dcli-claude.
`;

if (process.argv.includes('--help')) {
  console.log(help);
  process.exit(0);
}

const { parseArgs, buildEnvelope, resolvePrompt } = require('../core/commands/index');
const { JobStore } = require('../core/job-store');
const { getStateRoot, ensureStateRoot } = require('../core/state-root');
const { computeRepoKeyWithPath } = require('../core/repo-key');
const { Redactor } = require('../core/redactor');
const { setRedactor } = require('../core/fs-text');
const { AdmissionController } = require('../core/admission');

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

  const backend = parsed.backend || 'fake';

  let adapter;
  try {
    const adapterPath = path.resolve(__dirname, '..', 'adapters', backend, 'adapter');
    const mod = require(adapterPath);
    const AdapterClass = mod.FakeAdapter || mod[Object.keys(mod)[0]];
    adapter = new AdapterClass({ facts: getDefaultFacts(), exitCode: 0, declaredRungs: ['hard_kill'], capabilities: getDefaultCapabilities(backend) });
  } catch (err) {
    console.error(`Failed to load adapter "${backend}": ${err.message}`);
    process.exit(12);
  }

  const stateRoot = parsed.repo
    ? path.resolve(parsed.repo, '.dcli-state')
    : (process.env.DCLI_STATE_ROOT || path.join(getStateRoot(), 'test'));

  ensureStateRoot(stateRoot);

  const redactor = new Redactor();
  setRedactor(redactor);

  const admissionController = new AdmissionController({
    stateRoot,
    backendLimits: { opencode: 3, codex: 3, claude: 3 },
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

      const output = executeSubmit({
        store, adapter, repoKey, repoRoot: fullPath,
        prompt,
        hardTimeoutSec: parsed.hardTimeoutSec,
        group: parsed.group, label: parsed.label, model: parsed.model,
        access: parsed.access,
        reasoningEffort: parsed.reasoningEffort,
        variant: parsed.variant,
        effort: parsed.effort,
        admission: admissionController,
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
      const { executeWait, executeWaitAll } = require('../core/commands/wait');

      if (parsed.waitAll) {
        const result = await executeWaitAll({
          store, group: parsed.group,
          timeoutSec: parsed.timeoutSec || 60,
        });

        if (parsed.json) {
          console.log(JSON.stringify({ schema_version: 1, jobs: result.jobs }));
        } else {
          for (const j of result.jobs) {
            console.log(`${j.job_id}: ${j.timed_out ? 'timed_out' : 'done'} (exit ${j.exit_code})`);
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
        timeoutSec: parsed.timeoutSec || 60,
      });

      if (parsed.json) {
        console.log(JSON.stringify(result.envelope));
      } else if (result.timedOut) {
        console.log(`Job ${jobId} still active (timed out after ${parsed.timeoutSec || 60}s)`);
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

    case 'list': {
      const { executeList } = require('../core/commands/list');
      const result = await executeList({ store, repoKey, groupFilter: parsed.group });

      if (parsed.json) {
        console.log(JSON.stringify({ schema_version: 1, jobs: result.jobs }));
      } else {
        if (result.jobs.length === 0) {
          console.log('No jobs found.');
        } else {
          for (const j of result.jobs) {
            const line = `${j.job_id}  ${j.state.padEnd(12)} ${j.backend || '?'}  ${j.created_at || ''}`;
            console.log(line);
          }
        }
      }
      process.exit(0);
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

      if (result.errors.length > 0) {
        for (const err of result.errors) {
          console.error(`Error: ${err}`);
        }
      }

      if (result.dryRun) {
        console.log(`Dry-run: would remove ${result.removed} jobs`);
        if (result.scrubbed > 0) console.log(`  would scrub ${result.scrubbed} session ids`);
      } else {
        console.log(`Cleanup: ${result.removed} removed, ${result.skipped} skipped, ${result.scrubbed} scrubbed`);
      }
      process.exit(0);
    }

    case 'capabilities': {
      const { executeCapabilities } = require('../core/commands/capabilities');
      const result = await executeCapabilities({ adapter, json: parsed.json });
      console.log(JSON.stringify(result.manifest, null, 2));
      process.exit(0);
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

const path = require('path');

function getDefaultFacts() {
  return [
    { type: 'started', backend_pid: 1, backend_session_id: 'ses_default' },
    { type: 'assistant_text', message_id: 'm1', text: 'Hello from dcli' },
    { type: 'usage_reported', tokens: { input: 10, output: 20, total: 30 } },
    { type: 'process_exited', code: 0 },
  ];
}

function getDefaultCapabilities(backendName) {
  return {
    schema_version: 1,
    backend: backendName,
    backend_version: '1.0.0',
    core: { run: true, submit: true, resume: false, cancel: true, wrapper_worktree: true },
    extensions: {},
  };
}

main().catch(err => {
  console.error(err.message);
  process.exit(err.exitCode || 1);
});
