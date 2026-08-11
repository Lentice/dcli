/**
 * Fixture: a three-deep process tree used by the Windows tree-kill test
 * (ticket 103, criterion A). The root spawns a grandchild which spawns a
 * great-grandchild; each level prints its own pid to stdout (inherited up the
 * chain) and then stays alive so the tree can only end by being terminated.
 *
 *   root → grandchild → great-grandchild
 *
 * Usage: node windows-tree-child.js [root|grandchild|great-grandchild]
 * The root role is the default; the roles exist so a child can re-invoke this
 * same file. Spawned with windowsHide: true per docs/engineering/windows-spawning.md.
 */
const { spawn } = require('child_process');

const role = process.argv[2] || 'root';
console.log(`TREE_PID_${role}=${process.pid}`);

if (role === 'root') {
  const gc = spawn(process.execPath, [__filename, 'grandchild'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  gc.unref();
} else if (role === 'grandchild') {
  const ggc = spawn(process.execPath, [__filename, 'great-grandchild'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  ggc.unref();
}

setInterval(() => {}, 60000);
