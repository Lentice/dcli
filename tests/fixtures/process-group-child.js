/**
 * Fixture: spawns a grandchild WITHOUT `detached`, so the grandchild inherits
 * this process's process group — the group dcli created by spawning THIS
 * fixture detached. Prints the grandchild's pid, then stays alive until stdin
 * closes. With DCLI_IGNORE_SIGTERM=1 the fixture ignores SIGTERM.
 *
 * The shape is a backend that spawned a helper subprocess: signalling the
 * group kills both; signalling only the direct pid leaves the grandchild
 * reparented to init.
 */
const { spawn } = require('child_process');

if (process.env.DCLI_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => {});
}

const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
  stdio: 'ignore',
});
gc.unref();

console.log(`GRANDCHILD_PID=${gc.pid}`);
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
