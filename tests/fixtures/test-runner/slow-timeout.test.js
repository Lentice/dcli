// @suite full
// @serial  exercises coexistence with the full-suite marker
// @timeout-ms 10000
setTimeout(() => {
  console.log('PASS: slow-timeout.test.js');
  process.exit(0);
}, 1200);
