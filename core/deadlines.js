const DEFAULTS = Object.freeze({
  WORKER_STARTUP_SENTINEL_MS: 30000,
  BACKEND_FIRST_EVENT_WATCHDOG_MS: 120000,
  BACKEND_HEALTH_READY_MS: 30000,
  JOB_HARD_TIMEOUT_MS: 1800000,
  POST_EXIT_DRAIN_MS: 5000,
  HTTP_CONNECT_MS: 10000,
  HTTP_READ_MS: 60000,
  EVENT_STREAM_IDLE_MS: 120000,
  LOCK_ACQUISITION_MS: 10000,
  DOCTOR_LIVE_SMOKE_MS: 120000,
  STDIN_READ_MS: 5000,
  SNAPSHOT_FINALIZE_MS: 60000,
  ADAPTER_DISPOSE_MS: 5000,
});

const ENV_OVERRIDES = Object.freeze({
  WORKER_STARTUP_SENTINEL_MS: 'DCLI_STARTUP_TIMEOUT',
  JOB_HARD_TIMEOUT_MS: 'DCLI_HARD_TIMEOUT',
  POST_EXIT_DRAIN_MS: 'DCLI_POST_EXIT_DRAIN',
  HTTP_CONNECT_MS: 'DCLI_HTTP_CONNECT_TIMEOUT',
  HTTP_READ_MS: 'DCLI_HTTP_READ_TIMEOUT',
  ADAPTER_DISPOSE_MS: 'DCLI_TEST_DISPOSE_TIMEOUT_MS',
});

/**
 * Resolve a deadline value: explicit > env override > default.
 *
 * @param {string} name - key in DEFAULTS
 * @param {number|null|undefined} [suppliedValue]
 * @param {string} [envVar]
 * @returns {number} resolved ms value (0 = explicitly unbounded)
 */
function resolveDeadline(name, suppliedValue, envVar) {
  if (suppliedValue !== undefined && suppliedValue !== null) {
    return validateTimeoutMs(suppliedValue, name);
  }

  const envKey = envVar || ENV_OVERRIDES[name];
  if (envKey && process.env[envKey] !== undefined) {
    const parsed = parseInt(process.env[envKey], 10);
    if (isNaN(parsed) || parsed < 0 || !Number.isFinite(parsed)) {
      const err = new Error(`Invalid ${name} from env ${envKey}: "${process.env[envKey]}" — must be a non-negative integer`);
      err.exitCode = 2;
      throw err;
    }
    return parsed;
  }

  return DEFAULTS[name];
}

/**
 * Validate a timeout value before use.
 * Rejects: negative, NaN, Infinity, non-number.
 * Accepts: 0 (explicitly unbounded), positive finite number.
 *
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function validateTimeoutMs(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    const err = new Error(`Invalid ${name}: "${String(value)}" must be a finite number`);
    err.exitCode = 2;
    throw err;
  }
  if (value < 0) {
    const err = new Error(`${name} must not be negative, got ${value}`);
    err.exitCode = 2;
    throw err;
  }
  return value;
}

/**
 * Resolve the hard timeout for a synchronous run via the CLI flag.
 * If a positive number is supplied, use it verbatim. Otherwise,
 * resolve the default from resolveDeadline('JOB_HARD_TIMEOUT_MS').
 *
 * @param {number|undefined|null} hardTimeoutSec - --hard-timeout-sec value from parseArgs
 * @returns {number} milliseconds
 */
function resolveHardTimeoutMs(hardTimeoutSec) {
  if (hardTimeoutSec !== undefined && hardTimeoutSec !== null && hardTimeoutSec > 0) {
    return hardTimeoutSec * 1000;
  }
  return resolveDeadline('JOB_HARD_TIMEOUT_MS');
}

module.exports = { DEFAULTS, resolveDeadline, validateTimeoutMs, resolveHardTimeoutMs, ENV_OVERRIDES };
