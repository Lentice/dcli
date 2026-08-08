const assert = require('node:assert');
const fs = require('fs');

const { reduce } = require('../../core/reducer');
const { __setInjectHook, __resetInject } = require('../../core/inject-points');

const TERMINAL = Object.freeze(new Set(['done', 'failed', 'timed_out', 'cancelled', 'interrupted']));

function makeBaseState(overrides) {
  return {
    state: 'created',
    phase: null,
    job_id: 'fi-test',
    cancel_requested_at: null,
    hard_timeout_sec: null,
    started_at: null,
    failure_reason: null,
    backend_session_id: null,
    failure: null,
    ...overrides,
  };
}

function makeEvidence(overrides) {
  return {
    workerAlive: null,
    completionSentinelPresent: false,
    resultBytes: null,
    heartbeatAgeMs: null,
    jobId: 'fi-test',
    executionToken: null,
    executionTokenMatch: null,
    commandExitCode: null,
    ...overrides,
  };
}

function assertRecovery(result, { pointName, expectState }) {
  assert.ok(result && typeof result === 'object', `${pointName}: result must be an object`);
  assert.ok(TERMINAL.has(result.state),
    `${pointName}: state must be terminal or interrupted, got "${result.state}"`);
  assert.strictEqual(result.phase, 'terminal',
    `${pointName}: phase must be "terminal"`);

  if (expectState) {
    assert.strictEqual(result.state, expectState,
      `${pointName}: expected state "${expectState}", got "${result.state}"`);
  }
}

function assertJournalCoherent(journal, { pointName }) {
  assert.ok(Array.isArray(journal), `${pointName}: journal must be an array`);
  assert.ok(journal.length > 0, `${pointName}: journal must not be empty`);
  assert.ok(journal.every(e => e.seq && e.kind), `${pointName}: every journal entry must have seq and kind`);
}

function assertNoLocks(lockDir, { pointName }) {
  if (!lockDir || !fs.existsSync(lockDir)) return;
  const entries = fs.readdirSync(lockDir);
  const locks = entries.filter(e => e.endsWith('.lock'));
  assert.strictEqual(locks.length, 0,
    `${pointName}: expected zero lock files, found: ${locks.join(', ')}`);
}

function assertIdempotent(state, facts, evidence, { pointName }) {
  const first = reduce(state, facts, evidence);
  const second = reduce(state, facts, evidence);
  assert.deepStrictEqual(first, second,
    `${pointName}: recovery must be idempotent`);
}

function assertAllInvariants({ result, state, facts, evidence, journal, lockDir, pointName, expectState }) {
  assertRecovery(result, { pointName, expectState });
  assertJournalCoherent(journal, { pointName });
  assertNoLocks(lockDir, { pointName });
  assertIdempotent(state, facts, evidence, { pointName });
}

module.exports = {
  makeBaseState,
  makeEvidence,
  assertRecovery,
  assertJournalCoherent,
  assertNoLocks,
  assertIdempotent,
  assertAllInvariants,
  __setInjectHook,
  __resetInject,
  TERMINAL,
};
