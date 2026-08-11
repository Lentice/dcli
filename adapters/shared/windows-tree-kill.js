/**
 * Windows rung 2 (ADR-010): verified descendant enumeration + `taskkill /T /F`
 * against the exact enumerated pid set, recorded as a declared degraded
 * capability. This module is Windows-only; Unix never requires it
 * (`adapters/shared/process-lifecycle.js` routes there).
 *
 * Why it is degraded and why that is permanent: a descendant spawned between
 * enumeration and termination escapes, and pid reuse is reduced by
 * `pid + creation time + image path` but never disproved (ADR-008). So the
 * verification step decides every pid in the enumerated set against its own
 * record — nothing outside that set is ever signalled, and the result names
 * every survivor rather than claiming a kill it cannot verify.
 *
 * Identity follows `core/process-identity.js`'s notion: pid + creation time +
 * image path. Creation time is captured with the exact PowerShell
 * `Get-Process ... ToUniversalTime().ToString('o')` expression that
 * `core/process-identity.js`'s `getProcessStartTime` uses, so values are
 * comparable. Image path is an additional field `core/process-identity.js`
 * does not expose; it is compared the same way. Parent links come from
 * PowerShell 7's `Get-Process` `.Parent`, which Windows PowerShell 5.1 lacks,
 * so enumeration requires `pwsh` — when it is absent the rung fails closed
 * (nothing is signalled).
 */
const { spawn } = require('node:child_process');
const { isProcessAlive } = require('../../core/process-identity');

// The enumeration caps (criterion F): a finite depth, a finite node count, and
// a finite deadline. Hitting any of them is reported as truncation — reduced
// coverage is announced, never silently accepted.
const MAX_DEPTH = 32;
const MAX_NODES = 256;
const DEFAULT_ENUMERATION_DEADLINE_MS = 15000;
const DEFAULT_TREE_KILL_DEADLINE_MS = 20000;
const TREE_KILL_SETTLE_MS = 2000;
const TREE_KILL_POLL_MS = 100;
const PROCESS_QUERY_TIMEOUT_MS = 10000;
const PROCESS_QUERY_ATTEMPTS = 3;
const PROCESS_QUERY_RETRY_MS = 250;
const TASKKILL_TIMEOUT_MS = 5000;

const PROCESS_SNAPSHOT_SCRIPT = [
  'Get-Process | ForEach-Object {',
  '  $p = $_',
  '  $parentId = -1',
  '  try { if ($p.Parent) { $parentId = $p.Parent.Id } } catch {}',
  '  $start = $null',
  '  try { $start = $p.StartTime } catch {}',
  '  [PSCustomObject]@{',
  '    pid = $p.Id',
  '    parentPid = $parentId',
  '    createdAt = if ($start -and $start -ne [DateTime]::MinValue) { $start.ToUniversalTime().ToString(\'o\') } else { $null }',
  '    imagePath = $p.Path',
  '  }',
  '} | ConvertTo-Json -Compress',
].join('\n');

/**
 * Run a PowerShell script through `pwsh` (PowerShell 7), which Windows
 * PowerShell 5.1 lacks `Get-Process .Parent` from. Bounded by a finite
 * timeout (invariant 3) and a bounded attempt count — spawning a subprocess
 * can fail transiently under host load, and one failed query must not silently
 * disable the rung. Never throws: a query failure returns null.
 *
 * @param {string} script
 * @param {number} timeoutMs
 * @returns {Promise<Array<{ pid: number, parentPid: number, createdAt: string|null, imagePath: string|null }>|null>}
 */
function queryProcessSnapshot() {
  return new Promise((resolve) => {
    let attempts = 0;
    const tryOnce = () => {
      attempts++;
      queryProcessSnapshotOnce((parsed) => {
        if (parsed) return resolve(parsed);
        if (attempts < PROCESS_QUERY_ATTEMPTS) {
          setTimeout(tryOnce, PROCESS_QUERY_RETRY_MS);
          return;
        }
        resolve(null);
      });
    };
    tryOnce();
  });
}

function queryProcessSnapshotOnce(done) {
  let settled = false;
  let timer = null;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    done(value);
  };

  let child;
  try {
    child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_SNAPSHOT_SCRIPT], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return finish(null);
  }

  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.resume();
  child.on('error', () => finish(null));
  child.on('close', () => {
    try {
      const parsed = JSON.parse(out);
      finish(Array.isArray(parsed) && parsed.length > 0 ? parsed : null);
    } catch {
      finish(null);
    }
  });

  timer = setTimeout(() => {
    try { if (!child.killed) child.kill(); } catch {}
    finish(null);
  }, PROCESS_QUERY_TIMEOUT_MS);
  if (timer.unref) timer.unref();
}

/**
 * Walk the parent-pid graph from `rootPid` and capture `pid + creation time +
 * image path` for every reachable process. `rootPid` itself is the first
 * entry, so the returned set is exactly the set the caller may verify against
 * after signalling. Bounded in depth, node count and time; a hit on any cap is
 * reported in `truncated`, never silently swallowed.
 *
 * @param {number} rootPid
 * @param {{ deadlineMs?: number, querySnapshot?: () => Promise<Array<object>> }} [opts]
 *   `querySnapshot` is a test seam: the real default queries the OS via pwsh.
 * @returns {Promise<{ entries: Array<{ pid: number, parentPid: number, createdAt: string|null, imagePath: string|null }>, truncated: boolean }>}
 */
async function enumerateDescendants(rootPid, { deadlineMs = DEFAULT_ENUMERATION_DEADLINE_MS, querySnapshot = queryProcessSnapshot } = {}) {
  const started = Date.now();
  const snapshot = await querySnapshot();
  if (!snapshot) return { entries: [], truncated: true };

  const byPid = new Map();
  const byParent = new Map();
  for (const p of snapshot) {
    if (!p || !Number.isInteger(p.pid) || p.pid <= 0) continue;
    byPid.set(p.pid, p);
    const parent = Number.isInteger(p.parentPid) ? p.parentPid : -1;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(p);
  }

  const root = byPid.get(rootPid);
  // The root is already gone: there is nothing to enumerate, and therefore
  // nothing the caller may verify. Not truncation — an empty tree.
  if (!root) return { entries: [], truncated: false };

  const entries = [root];
  let queue = [root];
  let truncated = false;
  let depth = 0;

  while (queue.length > 0 && !truncated) {
    if (Date.now() - started >= deadlineMs) { truncated = true; break; }
    if (depth >= MAX_DEPTH) { truncated = true; break; }
    const next = [];
    for (const parent of queue) {
      const children = byParent.get(parent.pid) || [];
      for (const child of children) {
        if (entries.length >= MAX_NODES) { truncated = true; break; }
        entries.push(child);
        next.push(child);
      }
      if (truncated) break;
    }
    if (truncated) break;
    queue = next;
    depth++;
  }

  return { entries, truncated };
}

/**
 * Terminate a tree rooted at `rootPid` and verify the result against the
 * exact enumerated set. `taskkill /PID <rootPid> /T /F` is an argument array
 * with `windowsHide: true` and a finite timeout — never a shell string. The
 * taskkill exit code is not a verdict; every pid in `attempted` is re-checked,
 * and a pid is confirmed dead only when it is gone, or when a process with
 * that pid exists but no longer matches its enumerated identity (pid reuse).
 *
 * Anything spawned after enumeration is out of scope by construction — that is
 * the race ADR-010 names, and it is why `degraded` is permanently `true`.
 *
 * @param {number} rootPid
 * @param {{ deadlineMs?: number, querySnapshot?: () => Promise<Array<object>> }} [opts]
 * @returns {Promise<{ kind: string, degraded: boolean, attempted: number[], confirmedDead: number[], survivors: Array<{ pid: number, imagePath: string|null, reason: string }>, enumerationTruncated: boolean }>}
 */
async function terminateTree(rootPid, { deadlineMs = DEFAULT_TREE_KILL_DEADLINE_MS, querySnapshot = queryProcessSnapshot } = {}) {
  const started = Date.now();
  const query = querySnapshot || queryProcessSnapshot;

  const enumResult = await enumerateDescendants(rootPid, { deadlineMs, querySnapshot: query });
  if (enumResult.entries.length === 0) {
    // Nothing enumerated: the root is already gone, or the enumeration failed
    // (e.g. pwsh unavailable). No kill was attempted — rung 0's honest record.
    return {
      kind: 'none',
      degraded: true,
      attempted: [],
      confirmedDead: [],
      survivors: [],
      enumerationTruncated: enumResult.truncated,
    };
  }

  const attempted = enumResult.entries.map((e) => e.pid);
  await runTaskkill(rootPid, Math.min(TASKKILL_TIMEOUT_MS, Math.max(1, deadlineMs - (Date.now() - started))));

  // Bounded settle: a forced termination lands asynchronously, so a pid that
  // is merely still dying is not yet a survivor. Poll liveness for a finite
  // window, then do the identity verification once, against the enumerated set.
  const settleDeadline = Math.min(Date.now() + TREE_KILL_SETTLE_MS, started + deadlineMs);
  let alive = attempted;
  while (Date.now() < settleDeadline) {
    alive = attempted.filter((pid) => isProcessAlive(pid));
    if (alive.length === 0) break;
    await sleep(TREE_KILL_POLL_MS);
  }

  const confirmedDead = [];
  const survivors = [];
  if (alive.length === 0) {
    confirmedDead.push(...attempted);
  } else {
    const currentById = new Map((await query() || []).map((p) => [p.pid, p]));
    for (const entry of enumResult.entries) {
      const current = currentById.get(entry.pid);
      if (!current) {
        confirmedDead.push(entry.pid);
        continue;
      }
      const { sameProcess, reason } = classifyIdentity(entry, current);
      if (sameProcess) {
        survivors.push({ pid: entry.pid, imagePath: entry.imagePath || current.imagePath || null, reason });
      } else {
        confirmedDead.push(entry.pid);
      }
    }
  }

  return {
    kind: 'taskkill-tree',
    degraded: true,
    attempted,
    confirmedDead,
    survivors,
    enumerationTruncated: enumResult.truncated,
  };
}

/**
 * Decide whether a live pid is still the process enumeration recorded.
 *
 * - Alive and creation time AND image path both still match → the same
 *   process, still running: a survivor.
 * - Alive with a positive mismatch in creation time or image path → pid reuse;
 *   the original is dead, so this counts as confirmed dead.
 * - Alive but the current identity cannot be positively compared (an unknown
 *   creation time or image path) → the conservative answer is a survivor:
 *   reporting a kill we cannot verify is the exact lie this rung exists to
 *   avoid (ADR-010, "the line that does not move").
 *
 * @param {{ pid: number, createdAt: string|null, imagePath: string|null }} recorded
 * @param {{ pid: number, createdAt: string|null, imagePath: string|null }} current
 * @returns {{ sameProcess: boolean, reason: string }}
 */
function classifyIdentity(recorded, current) {
  const startMismatch = current.createdAt !== null && recorded.createdAt !== null &&
    current.createdAt !== recorded.createdAt;
  const imageMismatch = current.imagePath && recorded.imagePath &&
    current.imagePath.toLowerCase() !== recorded.imagePath.toLowerCase();
  if (startMismatch || imageMismatch) {
    return { sameProcess: false, reason: 'pid_reuse' };
  }
  return { sameProcess: true, reason: 'still_running' };
}

/**
 * `taskkill /PID <rootPid> /T /F` as an argument array, `windowsHide: true`,
 * finite timeout. Never a command string and never a shell. The exit code
 * is deliberately ignored — the re-check in `terminateTree` is the verdict.
 *
 * @param {number} rootPid
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function runTaskkill(rootPid, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('taskkill', ['/PID', String(rootPid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      return resolve();
    }
    const timer = setTimeout(() => {
      try { if (!child.killed) child.kill(); } catch {}
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.on('error', () => { clearTimeout(timer); resolve(); });
    child.on('close', () => { clearTimeout(timer); resolve(); });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  enumerateDescendants,
  terminateTree,
  queryProcessSnapshot,
  classifyIdentity,
  MAX_DEPTH,
  MAX_NODES,
  DEFAULT_ENUMERATION_DEADLINE_MS,
  DEFAULT_TREE_KILL_DEADLINE_MS,
};
