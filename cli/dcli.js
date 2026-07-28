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

const { parseArgs, buildEnvelope } = require('../core/commands/index');
const { JobStore } = require('../core/job-store');
const { getStateRoot } = require('../core/state-root');
const { computeRepoKeyWithPath } = require('../core/repo-key');

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
    adapter = new AdapterClass({ facts: getDefaultFacts(), exitCode: 0, declaredRungs: ['hard_kill'], capabilities: {} });
  } catch (err) {
    console.error(`Failed to load adapter "${backend}": ${err.message}`);
    process.exit(12);
  }

  const stateRoot = parsed.repo
    ? path.resolve(parsed.repo, '.dcli-state')
    : (process.env.DCLI_STATE_ROOT || path.join(getStateRoot(), 'test'));
  const store = new JobStore({ stateRoot });

  const repoPath = parsed.repo || process.cwd();
  const { repoKey, fullPath } = computeRepoKeyWithPath(repoPath);

  switch (parsed.command) {
    case 'run': {
      const { executeRun } = require('../core/commands/run');
      const prompt = parsed.positionals.join(' ') || '';

      const output = await executeRun({
        store, adapter, repoKey, repoRoot: fullPath,
        prompt,
        hardTimeoutSec: parsed.hardTimeoutSec,
        group: parsed.group, label: parsed.label, model: parsed.model,
      });

      if (parsed.json) {
        console.log(JSON.stringify(output.envelope));
      } else {
        console.log(output.text);
      }
      process.exit(0);
    }

    case 'submit': {
      const { executeSubmit } = require('../core/commands/submit');
      const prompt = parsed.positionals.join(' ') || '';

      const output = executeSubmit({
        store, repoKey, repoRoot: fullPath,
        prompt,
        hardTimeoutSec: parsed.hardTimeoutSec,
        group: parsed.group, label: parsed.label, model: parsed.model,
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

main().catch(err => {
  console.error(err.message);
  process.exit(err.exitCode || 1);
});
