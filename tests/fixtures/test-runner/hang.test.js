const fs = require('fs');
const path = require('path');
const pidFile = path.join(process.env.DCLI_TEST_RUNNER_TMP, 'hang-pid.txt');
fs.writeFileSync(pidFile, String(process.pid), 'utf8');
console.log('HANG: about to hang');
setTimeout(() => {}, 1000000);
