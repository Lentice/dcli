// Assertions for "this must fail" tests.
//
// Why this exists: `assert.ok(err, 'must fail')` passes for *any* throw,
// including a crash in our own code. That is not a hypothetical -- a
// `ReferenceError: child is not defined` in the codex adapter's Start() was the
// sole reason a temp-dir test passed, and it hid a defect that broke every
// codex job. The test was green for two commits.
//
// A failure test has to assert the failure's *identity*, not merely that
// something was thrown. ReferenceError and TypeError are almost never the
// failure mode under test; they are programmer errors wearing its costume.

const assert = require('node:assert');

// Errors that mean "our code is broken", never "the operation failed as
// designed". A test that accepts one of these is asserting nothing.
const PROGRAMMER_ERRORS = [ReferenceError, TypeError, SyntaxError, RangeError];

/**
 * Assert that `err` is a real, expected failure.
 *
 * @param {unknown} err            the caught value
 * @param {object}  [expect]
 * @param {number}  [expect.exitCode]  required error.exitCode
 * @param {RegExp}  [expect.match]     required to match error.message
 * @param {string}  [expect.code]      required error.code
 * @param {string}  [expect.failureClass] required error.failureClass
 * @param {string}  [what]         description used in assertion messages
 * @returns {Error} the same error, for further assertions
 */
function assertRealFailure(err, expect = {}, what = 'the operation') {
  assert.ok(err, `${what} must fail rather than silently succeed`);

  for (const Kind of PROGRAMMER_ERRORS) {
    assert.ok(
      !(err instanceof Kind),
      `${what} must fail with its real error, not a ${Kind.name} ` +
      `(that is a bug in our code masquerading as the failure under test): ` +
      `${err && err.stack}`
    );
  }

  // An expected failure carries *something* identifying. A bare `new Error()`
  // with no code, no exitCode and no message is indistinguishable from a crash.
  const hasIdentity = Boolean(
    (err.message && err.message.length > 0) || err.code || err.exitCode !== undefined
  );
  assert.ok(hasIdentity, `${what} failed with an unidentifiable error: ${err}`);

  if (expect.exitCode !== undefined) {
    assert.strictEqual(err.exitCode, expect.exitCode,
      `${what} must report exit ${expect.exitCode}, got ${err.exitCode}: ${err.message}`);
  }
  if (expect.code !== undefined) {
    assert.strictEqual(err.code, expect.code,
      `${what} must report code ${expect.code}, got ${err.code}: ${err.message}`);
  }
  if (expect.failureClass !== undefined) {
    assert.strictEqual(err.failureClass, expect.failureClass,
      `${what} must report failureClass ${expect.failureClass}, got ${err.failureClass}`);
  }
  if (expect.match !== undefined) {
    assert.match(err.message, expect.match,
      `${what} failed for an unexpected reason: ${err.message}`);
  }

  return err;
}

/**
 * Run `fn` and assert it fails in a specific, expected way. Accepts sync or
 * async functions. Fails if `fn` returns normally.
 *
 * @returns {Promise<Error>} the asserted error
 */
async function assertFailsWith(fn, expect = {}, what = 'the operation') {
  let err;
  let returned = false;
  try {
    await fn();
    returned = true;
  } catch (e) {
    err = e;
  }
  assert.ok(!returned, `${what} must fail rather than return normally`);
  return assertRealFailure(err, expect, what);
}

module.exports = { assertRealFailure, assertFailsWith, PROGRAMMER_ERRORS };
