/**
 * Fixture: simulates a long-lived backend server that continuously
 * produces verbose output on stdout. Never exits on its own.
 */
let count = 0;
const maxLines = parseInt(process.argv[2] || '10000', 10);

function emit() {
  if (count >= maxLines) {
    process.stdout.write('DONE_VERBOSE\n');
    return;
  }
  count++;
  process.stdout.write(`LOG_LINE_${count} ${'x'.repeat(120)}\n`);
  setImmediate(emit);
}

emit();

// Read stdin to stay alive for server simulation
process.stdin.resume();
process.stdin.on('data', () => {});

// Ignore SIGTERM so parent can test kill path
process.on('SIGTERM', () => {});
