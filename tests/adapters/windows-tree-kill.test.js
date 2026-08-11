// @suite full
// @serial  spawns real process trees and PowerShell process queries; run
//          isolated from the parallel batch so host load cannot time them out
//
// Ticket 103, criteria A/B/C/E/F. The Windows degraded tree kill (ADR-010
// rung 2): enumerate the backend's descendant set with its identity, terminate
// it with taskkill /T /F, and verify every pid against that exact set —
// reporting survivors rather than claiming a kill. These tests drive real
// process trees with plain Node fixtures, so no backend binary is needed.
//
// Windows-only by construction (ticket 91 discipline): on other platforms the
// suite must name the skip out loud, never sit silently green.
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { terminateProcessTree } = require('../../adapters/shared/process-lifecycle');
const {
  enumerateDescendants,
  terminateTree,
  queryProcessSnapshot,
  MAX_DEPTH,
  MAX_NODES,
} = require('../../adapters/shared/windows-tree-kill');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'windows-tree-child.js');
const DEAD_POLL_MS = 100;
const DEAD_DEADLINE_MS = 8000;
const READ_DEADLINE_MS = 10000;

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function waitUntilDead(pid) {
  const deadline = Date.now() + DEAD_DEADLINE_MS;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise(r => setTimeout(r, DEAD_POLL_MS));
  }
  return !isAlive(pid);
}

function spawnSleeper(env) {
  return spawn(process.execPath, ['-e', 'setInterval(()=>{}, 60000)'], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ...(env || {}) },
  });
}

// Read the fixture's self-reported pids off stdout: TREE_PID_root,
// TREE_PID_grandchild, TREE_PID_great-grandchild.
function readTreePids(child) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const wanted = ['root', 'grandchild', 'great-grandchild'];
    const found = {};
    const timer = setTimeout(() => reject(new Error('fixture did not print all TREE_PID markers in time')), READ_DEADLINE_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      for (const role of wanted) {
        const m = buf.match(new RegExp(`TREE_PID_${role}=(\\d+)`));
        if (m && found[role] === undefined) found[role] = parseInt(m[1], 10);
      }
      if (wanted.every((r) => found[r] !== undefined)) {
        clearTimeout(timer);
        resolve(found);
      }
    });
    child.on('exit', () => { clearTimeout(timer); reject(new Error('fixture exited before printing all TREE_PID markers')); });
  });
}

// Real identities for a set of pids, shaped exactly like the enumeration
// snapshot, so injected enumeration/verification data is genuine identity data.
async function realEntriesFor(pids) {
  const snapshot = await queryProcessSnapshot();
  if (!snapshot || snapshot.length === 0) {
    throw new Error('could not query real process identities for the injected snapshot');
  }
  const byPid = new Map(snapshot.map((p) => [p.pid, p]));
  return pids.map((pid) => {
    const e = byPid.get(pid) || { pid, parentPid: -1, createdAt: null, imagePath: null };
    return { ...e };
  });
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('SKIPPED (Windows-only): verified taskkill-tree termination tests — the degraded tree kill (ADR-010 rung 2, ticket 103) is Windows-specific; ticket 91 discipline requires naming the skip.');
    return;
  }

  // =========================================================================
  // Criterion A — a grandchild AND a great-grandchild of the backend are dead
  // after the rung, survivors empty, result shape and flags correct.
  // Criterion E — taskkill runs through the shared seam with a bounded call.
  // =========================================================================
  {
    const child = spawn(process.execPath, [FIXTURE], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    try {
      const { grandchild, 'great-grandchild': greatGrandchild } = await readTreePids(child);
      assert.ok(isAlive(child.pid), `root ${child.pid} must be alive before termination`);
      assert.ok(isAlive(grandchild), `grandchild ${grandchild} must be alive before termination`);
      assert.ok(isAlive(greatGrandchild), `great-grandchild ${greatGrandchild} must be alive before termination`);

      const result = await terminateProcessTree(child, { deadlineMs: 30000 });
      assert.strictEqual(result.kind, 'taskkill-tree');
      assert.strictEqual(result.degraded, true,
        'the record must say degraded even when nothing survived — the mechanism cannot prove there was nothing outside the enumerated set');
      assert.ok(await waitUntilDead(child.pid), 'backend child must be dead after the rung');
      assert.ok(await waitUntilDead(grandchild),
        `grandchild ${grandchild} must be dead after the rung — a direct-child kill would leave it alive`);
      assert.ok(await waitUntilDead(greatGrandchild),
        `great-grandchild ${greatGrandchild} must be dead after the rung — only a tree kill reaches it`);
      assert.deepStrictEqual(result.survivors, [], 'the tree must be fully dead, so survivors must be empty');
      for (const pid of [child.pid, grandchild, greatGrandchild]) {
        assert.ok(result.confirmedDead.includes(pid),
          `pid ${pid} must be named confirmedDead after the verified kill`);
      }
      assert.strictEqual(result.enumerationTruncated, false,
        'a normal three-deep tree must not trip the enumeration caps');
      console.log(`PASS: criterion A — grandchild (${grandchild}) and great-grandchild (${greatGrandchild}) died with the tree`);
    } finally {
      try { child.kill('SIGKILL'); } catch {}
    }
  }

  // =========================================================================
  // Criterion B (part 1) — a forced survivor is named in the result. The
  // survivor is a REAL process that taskkill genuinely cannot reach (it is not
  // a descendant of the root); the injected query only makes the enumeration
  // believe it is one, and the verification reports it still alive and still
  // matching its enumerated identity. The ticket sanctions injecting the
  // enumeration/verification results when a survivor cannot be constructed
  // reliably.
  // =========================================================================
  {
    const root = spawnSleeper();
    const survivor = spawnSleeper();
    try {
      const [rootEntry, survivorEntry] = await realEntriesFor([root.pid, survivor.pid]);
      survivorEntry.parentPid = root.pid;
      let calls = 0;
      // Call 1 enumerates the graph (root + survivor); call 2 is the
      // post-kill verification snapshot, in which the root is gone and the
      // survivor is still alive with its identity intact.
      const injected = async () => {
        calls++;
        return calls === 1 ? [rootEntry, survivorEntry] : [survivorEntry];
      };

      const result = await terminateTree(root.pid, { deadlineMs: 30000, querySnapshot: injected });
      assert.ok(await waitUntilDead(root.pid), 'root must be killed by the taskkill-tree rung');
      assert.strictEqual(result.kind, 'taskkill-tree');
      assert.strictEqual(result.survivors.length, 1,
        'a process still alive and still matching its enumerated identity must be named as a survivor');
      assert.strictEqual(result.survivors[0].pid, survivor.pid,
        'the survivor must be named by pid');
      assert.strictEqual(result.survivors[0].reason, 'still_running');
      assert.ok(result.survivors[0].imagePath, 'the survivor record must carry the image path');
      assert.ok(result.confirmedDead.includes(root.pid), 'root must be confirmedDead');
      assert.ok(!result.confirmedDead.includes(survivor.pid),
        'a matching live process must NOT be counted as dead');
      assert.strictEqual(calls, 2, 'the injected query must be used for enumeration and verification only');
      console.log(`PASS: criterion B — forced survivor (${survivor.pid}) is named in the result, not a clean kill`);
    } finally {
      try { root.kill('SIGKILL'); } catch {}
      try { survivor.kill('SIGKILL'); } catch {}
    }
  }

  // =========================================================================
  // Criterion C — a pid that is alive but no longer matches its enumerated
  // identity (pid reuse) counts as confirmed dead, not as a survivor.
  // =========================================================================
  {
    const root = spawnSleeper();
    const reusedPidHost = spawnSleeper();
    try {
      const [rootEntry, recordedEntry] = await realEntriesFor([root.pid, reusedPidHost.pid]);
      recordedEntry.parentPid = root.pid;
      // The process at the recorded pid is alive, but its creation time and
      // image path no longer match what was enumerated — pid reuse.
      const reused = { ...recordedEntry, createdAt: '1999-01-01T00:00:00.0000000Z', imagePath: 'C:\\WINDOWS\\system32\\unrelated.exe' };
      let calls = 0;
      // Call 1 enumerates (root + recorded); call 2 is the post-kill snapshot,
      // where the root is gone and the recorded pid is occupied by a different
      // process — the identity no longer matches, so it is pid reuse.
      const injected = async () => {
        calls++;
        return calls === 1 ? [rootEntry, recordedEntry] : [reused];
      };

      const result = await terminateTree(root.pid, { deadlineMs: 30000, querySnapshot: injected });
      assert.ok(await waitUntilDead(root.pid), 'root must be killed');
      assert.deepStrictEqual(result.survivors, [],
        'a reused pid is the original dead and a new process in its place — it must not be reported as a survivor');
      assert.ok(result.confirmedDead.includes(reusedPidHost.pid),
        'the reused pid must count as confirmed dead (pid reuse), even though a process occupies it');
      assert.ok(result.confirmedDead.includes(root.pid));
      console.log(`PASS: criterion C — reused pid (${reusedPidHost.pid}) counts as confirmed dead`);
    } finally {
      try { root.kill('SIGKILL'); } catch {}
      try { reusedPidHost.kill('SIGKILL'); } catch {}
    }
  }

  // =========================================================================
  // Criterion F — enumeration is bounded and a truncated walk is reported,
  // never silently accepted.
  // =========================================================================
  {
    // Depth cap: a synthetic chain deeper than MAX_DEPTH must report truncation.
    const root = 48999;
    const chain = [{ pid: root, parentPid: -1, createdAt: '2026-01-01T00:00:00.0000000Z', imagePath: 'C:\\fake\\node.exe' }];
    let parent = root;
    for (let i = 0; i < MAX_DEPTH + 20; i++) {
      const pid = 49000 + i;
      chain.push({ pid, parentPid: parent, createdAt: '2026-01-01T00:00:00.0000000Z', imagePath: 'C:\\fake\\node.exe' });
      parent = pid;
    }
    const enumResult = await enumerateDescendants(root, { querySnapshot: async () => chain });
    assert.strictEqual(enumResult.truncated, true, 'a chain deeper than the depth cap must be reported as truncated');
    assert.ok(enumResult.entries.length <= MAX_DEPTH + 1,
      `the walk must stop at the depth cap, got ${enumResult.entries.length} entries`);
    console.log(`PASS: criterion F (depth) — enumeration truncated at depth cap (${enumResult.entries.length} entries)`);
  }

  {
    // Node cap: a wide synthetic tree larger than MAX_NODES must truncate.
    const root = 48999;
    const wide = [{ pid: root, parentPid: -1, createdAt: '2026-01-01T00:00:00.0000000Z', imagePath: 'C:\\fake\\node.exe' }];
    for (let i = 0; i < MAX_NODES + 50; i++) {
      wide.push({ pid: 50000 + i, parentPid: root, createdAt: '2026-01-01T00:00:00.0000000Z', imagePath: 'C:\\fake\\node.exe' });
    }
    const enumResult = await enumerateDescendants(root, { querySnapshot: async () => wide });
    assert.strictEqual(enumResult.truncated, true, 'a tree wider than the node cap must be reported as truncated');
    assert.ok(enumResult.entries.length <= MAX_NODES + 1,
      `the walk must stop at the node cap, got ${enumResult.entries.length} entries`);
    console.log(`PASS: criterion F (nodes) — enumeration truncated at node cap (${enumResult.entries.length} entries)`);
  }

  {
    // The truncation flag survives into the terminateTree result (propagated,
    // not swallowed). Real root; a fake deep chain of non-alive pids parented
    // under it. taskkill kills only the real root; the fake pids are dead by
    // construction, so the only observable signal is enumerationTruncated.
    const root = spawnSleeper();
    const fakeChain = [{ pid: root.pid, parentPid: -1, createdAt: '2026-01-01T00:00:00.0000000Z', imagePath: 'C:\\fake\\node.exe' }];
    let parent = root.pid;
    for (let i = 0; i < MAX_DEPTH + 10; i++) {
      const pid = 51000 + i;
      if (isAlive(pid)) continue;
      fakeChain.push({ pid, parentPid: parent, createdAt: '2026-01-01T00:00:00.0000000Z', imagePath: 'C:\\fake\\node.exe' });
      parent = pid;
    }
    try {
      assert.ok(fakeChain.length >= MAX_DEPTH, 'could not reserve enough non-alive fake pids for the truncation test');
      const injected = async () => fakeChain;
      const result = await terminateTree(root.pid, { deadlineMs: 30000, querySnapshot: injected });
      assert.strictEqual(result.enumerationTruncated, true,
        'terminateTree must surface a truncated enumeration, never swallow it');
      console.log('PASS: criterion F (report) — enumerationTruncated propagates into the terminateTree result');
    } finally {
      try { root.kill('SIGKILL'); } catch {}
    }
  }
}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
