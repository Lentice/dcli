// @serial  serial marker protocol for exclusivity testing
// Serial fixture: writes a marker, sleeps, deletes marker, exits.

const fs = require('fs');
const path = require('path');
const marker = path.join(process.env.DCLI_TEST_RUNNER_TMP, 'serial-marker');
fs.writeFileSync(marker, 'serial', 'utf8');
setTimeout(() => {
  try { fs.unlinkSync(marker); } catch {}
  console.log('PASS: serial.test.js');
  process.exit(0);
}, 200);
