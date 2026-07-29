// Checks that no serial test is running when this parallel file executes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const marker = path.join(os.tmpdir(), 'dcli-serial-marker-test');
if (fs.existsSync(marker)) {
  console.error('FAIL: parallel-check ran during serial execution');
  process.exit(1);
}
console.log('PASS: parallel-check.test.js');
process.exit(0);
