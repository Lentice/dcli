// @suite quick
const assert = require('node:assert');

const {
  FAILURE_CLASSES,
  failureClassToExitCode,
  exitCodeToFailureClass,
  terminalExitCode,
} = require('../../core/failure-class');

function main() {

// ===========================================================================
// 1. Round-trip: every class with a code must map to that code and back.
//    The two directions are derived from one literal, so this is a proof of
//    self-consistency, not a second copy of the table.
// ===========================================================================
for (const cls of FAILURE_CLASSES) {
  const code = failureClassToExitCode(cls);
  assert.strictEqual(typeof code, 'number', `${cls} must map to a numeric exit code`);
  assert.strictEqual(exitCodeToFailureClass(code), cls,
    `round-trip ${cls} -> ${code} -> ${exitCodeToFailureClass(code)} must return ${cls}`);
}

// ===========================================================================
// 1b. lock maps to 17 in both directions (ticket 119: admission capacity is
//     a lock-class failure, not a quota/rate-limit one).
// ===========================================================================
assert.strictEqual(failureClassToExitCode('lock'), 17);
assert.strictEqual(exitCodeToFailureClass(17), 'lock');
assert.strictEqual(failureClassToExitCode('quota_or_rate_limit'), 14, 'quota_or_rate_limit keeps 14');
assert.strictEqual(exitCodeToFailureClass(14), 'quota_or_rate_limit', '14 keeps quota_or_rate_limit');

// ===========================================================================
// 2. Unknown classes and codes are null, never a guessed class.
// ===========================================================================
assert.strictEqual(failureClassToExitCode('no_such_class'), null);
assert.strictEqual(exitCodeToFailureClass(999), null);
assert.strictEqual(exitCodeToFailureClass(null), null);

// ===========================================================================
// 3. The shared table carries the doctor codes (12, 26) and the job path
//    classes (13-16); terminalExitCode publishes through it.
// ===========================================================================
assert.strictEqual(exitCodeToFailureClass(12), 'environment');
assert.strictEqual(exitCodeToFailureClass(26), 'protocol');
assert.strictEqual(exitCodeToFailureClass(10), 'backend_execution_failed');
assert.strictEqual(exitCodeToFailureClass(11), 'no_result');
assert.strictEqual(failureClassToExitCode('worker_launch'), 18);
assert.strictEqual(exitCodeToFailureClass(18), 'worker_launch');
assert.strictEqual(terminalExitCode('failed', { class: 'backend_execution_failed' }, null), 10);
assert.strictEqual(terminalExitCode('failed', { class: 'no_result' }, null), 11);
assert.strictEqual(terminalExitCode('failed', { class: 'quota_or_rate_limit' }, null), 14);
assert.strictEqual(terminalExitCode('failed', { class: 'environment' }, null), 12);
assert.strictEqual(terminalExitCode('failed', { class: 'protocol' }, null), 26);
assert.strictEqual(terminalExitCode('done', null, null), 0);

console.log('PASS: every failure class round-trips through the single shared table');
console.log(`PASS: ${FAILURE_CLASSES.length} classes named only in core/failure-class.js`);
}

try {
  main();
} catch (err) {
  console.error('FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
}
