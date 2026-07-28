/**
 * Fixture: writes ~100KB to stdout before touching stdin.
 * If the parent writes stdin before consuming stdout, both deadlock.
 */
const size = parseInt(process.argv[2] || '100', 10);
const chunk = 'x'.repeat(size * 1024);

process.stdout.write(chunk);
process.stdout.write('\nEND_OF_STDOUT\n');

let stdinTotal = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinTotal += chunk.length;
});
process.stdin.on('end', () => {
  process.stderr.write(`stdin_received:${stdinTotal}\n`);
  process.exit(0);
});
// Resume stdin to start flow
process.stdin.resume();

// Safety timeout: if stdin never arrives, exit nonzero
setTimeout(() => {
  process.stderr.write('TIMEOUT: stdin never arrived\n');
  process.exit(1);
}, 10000).unref();
