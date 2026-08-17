const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveDeadline } = require('../deadlines');
const { isAvailable, resolveHelperPath } = require('../containment');
const { failureClassToExitCode } = require('../failure-class');
const { assertStateRootWritable } = require('../state-root');

const PROBE_TIMEOUT_MS = 10000;

async function executeDoctor({ adapter, stateRoot, repoPath, json, liveSmokeTimeoutSec }) {
  const probes = await runCommonProbes({ stateRoot, repoPath });
  const liveSmokeTimeoutMs = liveSmokeTimeoutSec === undefined || liveSmokeTimeoutSec === null
    ? resolveDeadline('DOCTOR_LIVE_SMOKE_MS')
    : resolveDeadline('DOCTOR_LIVE_SMOKE_MS', liveSmokeTimeoutSec * 1000);

  if (liveSmokeTimeoutMs > 0) {
    probes.push(await runLiveSmoke(adapter, liveSmokeTimeoutMs, repoPath));
  } else {
    probes.push({
      name: 'live_smoke',
      ok: true,
      status: 'skipped',
      detail: 'Live smoke skipped by --live-smoke-timeout-sec 0; coverage is static-only',
    });
  }

  let backendInfo = {};
  try {
    const diag = adapter.CollectDiagnostics({});
    backendInfo = {
      backend: diag.backend,
      facts_emitted: diag.facts_emitted,
      exit_code: diag.exit_code,
    };
  } catch (err) {
    backendInfo = { error: err.message };
  }

  let identity = {};
  try {
    identity = adapter.GetIdentity();
  } catch (err) {
    identity = { error: err.message };
  }

  const envelope = {
    schema_version: 1,
    backend: identity.backend || 'unknown',
    adapter_version: identity.adapter_version || null,
    probes,
    backend_info: backendInfo,
    ok: probes.every(probe => probe.ok === true),
    coverage: liveSmokeTimeoutMs > 0 ? 'full' : 'static_only',
    live_smoke_timeout_sec: liveSmokeTimeoutMs / 1000,
  };

  return { envelope, json };
}

async function runLiveSmoke(adapter, timeoutMs, repoPath) {
  let timerHandle;
  const probePromise = new Promise((resolve, reject) => {
    // Arm the deadline before calling adapter code. A synchronous executable
    // resolver must not postpone the smoke's entire budget.
    queueMicrotask(async () => {
      try {
        const smokeMethod = typeof adapter.LiveSmokeRequest === 'function'
          ? adapter.LiveSmokeRequest
          : adapter.LiveSmoke;
        if (typeof smokeMethod !== 'function') {
          throw new Error('Adapter does not implement LiveSmoke');
        }
        const smoke = smokeMethod.bind(adapter);
        const result = await smoke(timeoutMs, repoPath);
        const responseBytes = result && typeof result.text === 'string'
          ? Buffer.byteLength(result.text, 'utf8')
          : null;
        resolve({
          name: 'live_smoke',
          ok: true,
          detail: responseBytes === null
            ? 'Backend live smoke check passed'
            : `Backend live smoke check passed; received ${responseBytes} response bytes`,
        });
      } catch (err) {
        reject(err);
      }
    });
  });

  const timer = new Promise((_, reject) => {
    timerHandle = setTimeout(() => {
      try { adapter.Dispose({}); } catch {}
      const err = new Error(`Live smoke timed out after ${timeoutMs}ms`);
      err.code = 'DOCTOR_SMOKE_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([probePromise, timer]);
  } catch (err) {
    const timedOut = err && err.code === 'DOCTOR_SMOKE_TIMEOUT';
    const failureClass = timedOut ? 'environment' : classifySmokeFailure(err);
    return {
      name: 'live_smoke',
      ok: false,
      status: timedOut ? 'timed_out' : 'failed',
      failure_class: failureClass,
      exit_code: smokeExitCode(failureClass),
      detail: timedOut
        ? err.message
        : `Backend live smoke failed (${failureClass}): ${err && err.message ? err.message : 'unknown error'}`,
    };
  } finally {
    clearTimeout(timerHandle);
  }
}

function classifySmokeFailure(err) {
  const hinted = err && (err.failureClass || err.classHint || err.class_hint);
  if (hinted === 'authentication' || hinted === 'quota_or_rate_limit' ||
      hinted === 'permission_or_sandbox' || hinted === 'network_error') {
    return hinted;
  }
  if (hinted === 'protocol' || hinted === 'protocol_incompatible') return 'protocol';

  const message = err && err.message ? err.message : '';
  if (/auth|login|token|api key|unauthori[sz]ed/i.test(message)) return 'authentication';
  if (/quota|rate.?limit|credit|billing/i.test(message)) return 'quota_or_rate_limit';
  if (/permission|access denied|sandbox/i.test(message)) return 'permission_or_sandbox';
  if (/network|connection refused|connection reset|ENOTFOUND|ECONN/i.test(message)) return 'network_error';
  if (/protocol|endpoint|malformed|incompatible/i.test(message)) return 'protocol';
  return 'environment';
}

function smokeExitCode(failureClass) {
  return failureClassToExitCode(failureClass) ?? 12;
}

async function probeContainmentHelper() {
  try {
    const available = isAvailable();
    if (available) {
      return { name: 'containment_helper', ok: true, detail: `Containment helper available at: ${resolveHelperPath()}` };
    }
    return { name: 'containment_helper', ok: false, detail: 'Containment helper not found. Build it: dotnet build native/windows-job-helper' };
  } catch (err) {
    return { name: 'containment_helper', ok: false, detail: `Containment helper check failed: ${err.message}` };
  }
}

async function runCommonProbes({ stateRoot, repoPath }) {
  const probes = [];

  probes.push(await probeWithTimeout(probeStateRoot(stateRoot), PROBE_TIMEOUT_MS, 'state_root'));
  probes.push(await probeWithTimeout(probeContainmentHelper(), PROBE_TIMEOUT_MS, 'containment_helper'));
  probes.push(await probeWithTimeout(probeGit(), PROBE_TIMEOUT_MS, 'git'));
  probes.push(await probeWithTimeout(probeRepo(repoPath), PROBE_TIMEOUT_MS, 'repo_resolution'));

  return probes;
}

async function probeStateRoot(stateRoot) {
  try {
    assertStateRootWritable(stateRoot);
    return { name: 'state_root', ok: true, detail: `state root is writable: ${stateRoot}` };
  } catch (err) {
    return { name: 'state_root', ok: false, detail: err.message };
  }
}

async function probeGit() {
  try {
    const result = spawnSync('git', ['--version'], {
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8',
    });
    if (result.status === 0 && result.stdout.trim().length > 0) {
      return { name: 'git', ok: true, detail: `git available: ${result.stdout.trim()}` };
    }
    return { name: 'git', ok: false, detail: 'git --version returned non-zero' };
  } catch (err) {
    return { name: 'git', ok: false, detail: `git not available: ${err.message}` };
  }
}

async function probeRepo(repoPath) {
  if (!repoPath) {
    return { name: 'repo_resolution', ok: false, detail: 'no repo path provided' };
  }
  try {
    const resolved = path.resolve(repoPath);
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      return {
        name: 'repo_resolution',
        ok: true,
        detail: `repo path resolvable: ${resolved} (${stat.isDirectory() ? 'directory' : 'file'})`,
      };
    }
    return { name: 'repo_resolution', ok: false, detail: `repo path does not exist: ${resolved}` };
  } catch (err) {
    return { name: 'repo_resolution', ok: false, detail: `repo resolution error: ${err.message}` };
  }
}

async function probeWithTimeout(probePromise, timeoutMs, name) {
  const timer = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Probe "${name}" timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([probePromise, timer]);
  } catch (err) {
    return { name, ok: false, detail: err.message };
  }
}

module.exports = { executeDoctor };
