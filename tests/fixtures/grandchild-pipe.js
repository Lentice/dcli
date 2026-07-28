/**
 * Fixture: spawns a grandchild that inherits stdout, then exits.
 * The grandchild holds the stdout pipe open, simulating surviving children
 * that prevent EOF on the parent's read of child stdout.
 */
const { spawn } = require('child_process');

// Grandchild: stays alive holding the inherited stdout
const gc = spawn(process.execPath, [
  '-e',
  'setInterval(()=>{process.stdout.write("gckeep\n")}, 60000).unref(); process.stdin.resume()',
], {
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
});
gc.unref();

// Write a known amount of output
for (let i = 0; i < 5; i++) {
  console.log(`child_line_${i}`);
}

// Signal we're done and exit
console.log('CHILD_EXITING');
process.exit(0);
