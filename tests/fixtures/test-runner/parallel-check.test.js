// Checks that no serial test is running when this parallel file executes.
const fs = require('fs');
const path = require('path');
const marker = path.join(process.env.DCLI_TEST_RUNNER_TMP, 'serial-marker');
if (fs.existsSync(marker)) {
  console.error('FAIL: parallel-check ran during serial execution');
  process.exit(1);
}
console.log('PASS: parallel-check.test.js');
process.exit(0);
