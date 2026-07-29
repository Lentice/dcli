// @serial  serial marker protocol for exclusivity testing
// Serial fixture: writes a marker, sleeps, deletes marker, exits.
const fs = require('fs');
const os = require('os');
const path = require('path');
const marker = path.join(os.tmpdir(), 'dcli-serial-marker-test');
fs.writeFileSync(marker, 'serial', 'utf8');
setTimeout(() => {
  try { fs.unlinkSync(marker); } catch {}
  console.log('PASS: serial.test.js');
  process.exit(0);
}, 200);
