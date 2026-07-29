const fs = require('fs');
const path = require('path');
const os = require('os');
const pidFile = path.join(os.tmpdir(), 'dcli-hang-pid.txt');
fs.writeFileSync(pidFile, String(process.pid), 'utf8');
console.log('HANG: about to hang');
setTimeout(() => {}, 1000000);
