// @suite quick
// The helper that guards against false greens must itself be proven to reject
// what it claims to reject -- an assertion helper that accepts everything
// manufactures the exact defect it exists to prevent.
const assert = require('node:assert');
const { assertRealFailure, assertFailsWith } = require('./assert-failure');

// Returns true if `fn` failed an assertion (i.e. the helper rejected the input).
function rejects(fn) {
  try {
    fn();
    return false;
  } catch (err) {
    if (err instanceof assert.AssertionError) return true;
    throw err;
  }
}

async function rejectsAsync(fn) {
  try {
    await fn();
    return false;
  } catch (err) {
    if (err instanceof assert.AssertionError) return true;
    throw err;
  }
}

async function main() {

// ===========================================================================
// 1. Programmer errors are rejected, whatever else they carry
// ===========================================================================
{
  for (const Kind of [ReferenceError, TypeError, SyntaxError, RangeError]) {
    const err = new Kind('child is not defined');
    assert.ok(rejects(() => assertRealFailure(err)),
      `${Kind.name} must be rejected as a real failure`);

    // Even with a plausible exitCode attached, it is still a crash.
    err.exitCode = 25;
    assert.ok(rejects(() => assertRealFailure(err, { exitCode: 25 })),
      `${Kind.name} must be rejected even when it carries the expected exitCode`);
  }
  console.log('PASS: programmer errors are rejected even when they look expected');
}

// ===========================================================================
// 2. A missing failure is rejected -- this is the bare assert.ok(err) hole
// ===========================================================================
{
  assert.ok(rejects(() => assertRealFailure(undefined)), 'undefined must be rejected');
  assert.ok(rejects(() => assertRealFailure(null)), 'null must be rejected');
  assert.ok(await rejectsAsync(() => assertFailsWith(() => 'returned fine')),
    'a function that returns normally must be rejected');
  console.log('PASS: a non-failure is rejected');
}

// ===========================================================================
// 3. An unidentifiable error is rejected
// ===========================================================================
{
  assert.ok(rejects(() => assertRealFailure(new Error(''))),
    'an error with no message, code or exitCode must be rejected');
  console.log('PASS: an unidentifiable error is rejected');
}

// ===========================================================================
// 4. Wrong identity is rejected
// ===========================================================================
{
  const err = new Error('not a git repo');
  err.exitCode = 23;
  err.code = 'REPO_STATE';
  err.failureClass = 'precondition';

  assert.ok(rejects(() => assertRealFailure(err, { exitCode: 25 })), 'wrong exitCode must be rejected');
  assert.ok(rejects(() => assertRealFailure(err, { code: 'OTHER' })), 'wrong code must be rejected');
  assert.ok(rejects(() => assertRealFailure(err, { failureClass: 'other' })),
    'wrong failureClass must be rejected');
  assert.ok(rejects(() => assertRealFailure(err, { match: /quota/i })),
    'non-matching message must be rejected');
  console.log('PASS: wrong failure identity is rejected');
}

// ===========================================================================
// 5. A genuine, fully-identified failure is accepted and returned
// ===========================================================================
{
  const err = new Error('not a git repo');
  err.exitCode = 23;
  err.code = 'REPO_STATE';
  err.failureClass = 'precondition';

  const returned = assertRealFailure(err,
    { exitCode: 23, code: 'REPO_STATE', failureClass: 'precondition', match: /not a git repo/i });
  assert.strictEqual(returned, err, 'the asserted error must be returned for further assertions');

  const fromThrow = await assertFailsWith(() => { throw err; }, { exitCode: 23 });
  assert.strictEqual(fromThrow, err, 'assertFailsWith must return the caught error');

  const fromAsyncThrow = await assertFailsWith(async () => { throw err; }, { exitCode: 23 });
  assert.strictEqual(fromAsyncThrow, err, 'assertFailsWith must work on async functions');

  console.log('PASS: a genuine identified failure is accepted');
}

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
