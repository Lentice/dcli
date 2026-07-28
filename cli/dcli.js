const help = `dcli — delegate work to a coding-agent CLI

Usage:
  dcli --backend <name> <command> [options]

Commands:
  run       Run a prompt
  submit    Submit a background job
  wait      Wait for a job status
  list      List jobs
  cancel    Cancel a job
  review    Run a code review

Options:
  --help    Show this message

Backends:
  opencode  opencode serve per job over HTTP
  codex     codex exec --json, prompt on stdin
  claude    claude -p --output-format stream-json

Each backend has its own shim: dcli-opencode, dcli-codex, dcli-claude.
`;

if (process.argv.includes('--help')) {
  console.log(help);
  process.exit(0);
}

console.log('dcli: use --help to see usage');
