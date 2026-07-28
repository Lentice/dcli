const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveDeadline } = require('../deadlines');
const { isAvailable, resolveHelperPath } = require('../containment');

const PROBE_TIMEOUT_MS = 10000;

async function executeDoctor({ adapter, stateRoot, repoPath, json, liveSmokeTimeoutSec }) {
  const probes = await runCommonProbes({ stateRoot, repoPath });

  if (liveSmokeTimeoutSec) {
    const timeoutMs = liveSmokeTimeoutSec * 1000;
    probes.push(await runLiveSmoke(adapter, timeoutMs));
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
    live_smoke_timeout_sec: liveSmokeTimeoutSec || null,
  };

  return { envelope, json };
}

async function runLiveSmoke(adapter, timeoutMs) {
  const probePromise = (async () => {
    try {
      if (typeof adapter.LiveSmoke === 'function') {
        await adapter.LiveSmoke(timeoutMs);
      }
      return { name: 'live_smoke', ok: true, detail: 'Backend live smoke check passed' };
    } catch (err) {
      return { name: 'live_smoke', ok: false, status: 'failed', detail: `Environment failure: ${err.message}` };
    }
  })();

  const timer = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('timed_out')), timeoutMs);
  });

  try {
    return await Promise.race([probePromise, timer]);
  } catch (err) {
    return { name: 'live_smoke', ok: false, status: 'timed_out', detail: `Live smoke timed out after ${timeoutMs}ms` };
  }
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
  const testFile = path.join(stateRoot, '.dcli-probe-' + Date.now());
  try {
    if (!fs.existsSync(stateRoot)) {
      fs.mkdirSync(stateRoot, { recursive: true });
    }
    fs.writeFileSync(testFile, 'ok', 'utf8');
    fs.unlinkSync(testFile);
    return { name: 'state_root', ok: true, detail: `state root is writable: ${stateRoot}` };
  } catch (err) {
    return { name: 'state_root', ok: false, detail: `state root not writable: ${err.message}` };
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
