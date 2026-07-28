const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

let getOwnIdentity, generateExecutionToken, formatWorkerIdentity;
let parseWorkerIdentity, identitiesMatch, isProcessAlive;
let PROCESS_START_TIME;

function loadModules() {
  const pi = require('../../core/process-identity');
  getOwnIdentity = pi.getOwnIdentity;
  generateExecutionToken = pi.generateExecutionToken;
  formatWorkerIdentity = pi.formatWorkerIdentity;
  parseWorkerIdentity = pi.parseWorkerIdentity;
  identitiesMatch = pi.identitiesMatch;
  isProcessAlive = pi.isProcessAlive;
  PROCESS_START_TIME = pi.PROCESS_START_TIME;
}

// ===========================================================================
// 1. getOwnIdentity returns the correct shape
// ===========================================================================

{
  loadModules();
  const identity = getOwnIdentity();

  assert.strictEqual(typeof identity, 'object');
  assert.strictEqual(typeof identity.pid, 'number');
  assert.strictEqual(identity.pid, process.pid, 'pid must match process.pid');
  assert.strictEqual(typeof identity.ppid, 'number');
  assert.strictEqual(identity.ppid, process.ppid, 'ppid must match process.ppid');
  assert.strictEqual(typeof identity.startTime, 'string');
  assert.ok(identity.startTime.endsWith('Z'), 'startTime must be UTC ISO');
  assert.strictEqual(typeof identity.imagePath, 'string');
  assert.strictEqual(identity.imagePath, process.execPath, 'imagePath must match process.execPath');
  assert.strictEqual(typeof identity.hostname, 'string');
  assert.strictEqual(identity.hostname, os.hostname(), 'hostname must match os.hostname()');
}

console.log('PASS: getOwnIdentity shape');

// ===========================================================================
// 2. generateExecutionToken produces unique random tokens
// ===========================================================================

{
  loadModules();
  const token1 = generateExecutionToken();
  const token2 = generateExecutionToken();

  assert.strictEqual(typeof token1, 'string');
  assert.ok(token1.length > 0, 'Token must not be empty');
  assert.notStrictEqual(token1, token2, 'Two tokens must be different');
  assert.ok(/^[0-9a-f]+$/.test(token1), 'Token must be lowercase hex');
}

console.log('PASS: generateExecutionToken uniqueness');

// ===========================================================================
// 3. formatWorkerIdentity and parseWorkerIdentity round-trip
// ===========================================================================

{
  loadModules();
  const pid = 12345;
  const startTime = '2026-07-28T12:00:00.000Z';
  const formatted = formatWorkerIdentity(pid, startTime);
  assert.strictEqual(formatted, '12345;2026-07-28T12:00:00.000Z');

  const parsed = parseWorkerIdentity(formatted);
  assert.ok(parsed !== null);
  assert.strictEqual(parsed.pid, pid);
  assert.strictEqual(parsed.startTime, startTime);

  // parseWorkerIdentity handles null/undefined
  assert.strictEqual(parseWorkerIdentity(null), null);
  assert.strictEqual(parseWorkerIdentity(''), null);
  assert.strictEqual(parseWorkerIdentity('not-a-pid'), null);
  assert.strictEqual(parseWorkerIdentity('abc;time'), null);
}

console.log('PASS: worker identity formatting and parsing');

// ===========================================================================
// 4. identitiesMatch compares correctly
// ===========================================================================

{
  loadModules();
  const a = { pid: 123, startTime: '2026-01-01T00:00:00.000Z' };
  const b = { pid: 123, startTime: '2026-01-01T00:00:00.000Z' };
  const c = { pid: 123, startTime: '2026-01-02T00:00:00.000Z' };
  const d = { pid: 456, startTime: '2026-01-01T00:00:00.000Z' };

  assert.ok(identitiesMatch(a, b), 'Identical identities must match');
  assert.ok(!identitiesMatch(a, c), 'Different startTime must not match');
  assert.ok(!identitiesMatch(a, d), 'Different pid must not match');
  assert.ok(!identitiesMatch(null, a), 'null must not match');
  assert.ok(!identitiesMatch(a, null), 'null must not match');
  assert.ok(!identitiesMatch(null, null), 'null+null must not match');
}

console.log('PASS: identitiesMatch comparison');

// ===========================================================================
// 5. isProcessAlive returns true for own pid, false for invalid
// ===========================================================================

{
  loadModules();

  // Own pid is always alive
  assert.ok(isProcessAlive(process.pid), 'Own pid must be alive');

  // Negative pid is never alive
  assert.ok(!isProcessAlive(-1), 'Negative pid must not be alive');

  // Zero pid is never alive
  assert.ok(!isProcessAlive(0), 'Zero pid must not be alive');

  // Very large pid is unlikely to be alive
  assert.ok(!isProcessAlive(999999999), 'Large pid unlikely to be alive');
}

console.log('PASS: isProcessAlive checks');

// ===========================================================================
// 6. PROCESS_START_TIME is set at module load time
// ===========================================================================

{
  loadModules();
  assert.ok(PROCESS_START_TIME instanceof Date, 'PROCESS_START_TIME must be a Date');
  const now = new Date();
  assert.ok(PROCESS_START_TIME <= now, 'PROCESS_START_TIME must be <= now');
  // Should be fairly recent (within the last minute)
  assert.ok(now.getTime() - PROCESS_START_TIME.getTime() < 60000, 'PROCESS_START_TIME must be recent');
}

console.log('PASS: PROCESS_START_TIME');

// ===========================================================================
// 7. PID-reuse simulation — identity detects pid collision via execution token
// ===========================================================================

{
  loadModules();
  const own = getOwnIdentity();

  // Simulate: a stale lock file claims pid=our_pid but wrong startTime + token
  const impostorPid = own.pid;
  const impostorStartTime = '2025-01-01T00:00:00.000Z'; // different from ours

  // The impostor record has same pid but different startTime
  const impostorIdentity = { pid: impostorPid, startTime: impostorStartTime };

  // identitiesMatch should detect the difference even though pid is same
  assert.ok(!identitiesMatch(own, impostorIdentity),
    'Same pid with different startTime must not match');
}

console.log('PASS: PID-reuse simulation (identity mismatch via startTime)');

// ===========================================================================
// Summary
// ===========================================================================

console.log('\nAll process-identity tests passed.');
