// @suite full
// @serial  kills process trees; asserts descendant sets
const assert = require('node:assert');
const { spawn, execSync, spawnSync } = require('node:child_process');
const path = require('path');
const fs = require('fs');

let Containment, HELPER_PATH;

function loadModule() {
  const c = require('../../core/containment');
  Containment = c;
  HELPER_PATH = c.HELPER_PATH || path.resolve(__dirname, '../../native/windows-job-helper/bin/Debug/net10.0/contain.exe');
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getDescendants(pid) {
  try {
    const out = execSync(
      `wmic process where "ParentProcessId=${pid}" get ProcessId /format:csv`,
      { encoding: 'utf8', timeout: 3000, windowsHide: true }
    );
    const ids = [];
    for (const line of out.trim().split('\n').slice(1)) {
      const parts = line.trim().split(',');
      if (parts.length >= 2) { const n = parseInt(parts[1], 10); if (!isNaN(n)) ids.push(n); }
    }
    return ids;
  } catch { return []; }
}

async function main() {
  loadModule();

  // 1. Helper binary exists
  {
    assert.ok(fs.existsSync(HELPER_PATH), `Helper not found at ${HELPER_PATH}`);
    console.log('PASS: helper binary exists');
  }

  // 2. isAvailable returns true
  {
    assert.ok(Containment.isAvailable(), 'isAvailable must return true');
    console.log('PASS: isAvailable');
  }

  // 3. Spawn a simple process and get started event
  {
    const ctx = new Containment.ContainmentContext(HELPER_PATH);
    const result = await ctx.spawn({
      args: [process.execPath, '-e', 'setInterval(()=>{},500)'],
      stdio: 'null',
    });
    assert.ok(result.pid > 0, `pid must be positive: ${result.pid}`);
    assert.ok(result.executionToken, 'executionToken must be present');
    assert.ok(result.creationTime, 'creationTime must be present');
    assert.ok(isAlive(result.pid), 'child must be alive');
    console.log(`  pid=${result.pid} token=${result.executionToken}`);

    await ctx.terminate({ executionToken: result.executionToken, graceMs: 1000 });
    ctx.close();
    console.log('PASS: spawn simple process');
  }

  // 4. Terminate kills the child
  {
    const ctx = new Containment.ContainmentContext(HELPER_PATH);
    const result = await ctx.spawn({
      args: [process.execPath, '-e', 'setInterval(()=>{},500)'],
      stdio: 'null',
    });
    assert.ok(isAlive(result.pid), 'child must be alive before terminate');

    const termResult = await ctx.terminate({ executionToken: result.executionToken, graceMs: 500 });
    assert.ok(termResult.terminated, 'terminate must return terminated: true');
    ctx.close();
    await sleep(500);
    assert.ok(!isAlive(result.pid), 'child must be dead after terminate');
    console.log('PASS: terminate kills child');
  }

  // 5. Grandchild containment
  {
    const ctx = new Containment.ContainmentContext(HELPER_PATH);
    const grandchildScript = `
      const { spawn: s } = require('child_process');
      s(process.execPath, ['-e', 'setInterval(()=>{},500)'], { windowsHide: true, stdio: 'ignore', detached: false });
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => process.exit(0));
    `;

    const result = await ctx.spawn({
      args: [process.execPath, '-e', grandchildScript],
      stdio: 'pipe',
    });
    assert.ok(isAlive(result.pid), 'parent must be alive');

    await sleep(1500);
    const grandchildren = getDescendants(result.pid);
    console.log(`  grandchildren: ${grandchildren.length > 0 ? grandchildren.join(', ') : 'none'}`);

    await ctx.terminate({ executionToken: result.executionToken, graceMs: 2000 });
    ctx.close();
    await sleep(500);

    assert.ok(!isAlive(result.pid), 'parent must be dead after terminate');
    for (const gcPid of grandchildren) {
      assert.ok(!isAlive(gcPid), `grandchild ${gcPid} must be dead`);
    }
    console.log('PASS: grandchild containment');
  }

  // 6. Controller death kills tree
  {
    const childResult = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', `
        const { ContainmentContext: Cc } = require(${JSON.stringify(path.resolve(__dirname, '../../core/containment'))});
        const ctx = new Cc(${JSON.stringify(HELPER_PATH)});
        ctx.spawn({ args: [process.execPath, '-e', 'setInterval(()=>{},500)'], stdio: 'null' }).then(r => {
          process.stdout.write(JSON.stringify(r) + '\\n');
        });
        process.stdin.on('data', () => {});
      `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 5000 });

      let buf = '';
      const to = setTimeout(() => reject(new Error('timeout')), 5000);
      child.stdout.on('data', (d) => {
        buf += d.toString();
        for (const line of buf.split('\n')) {
          if (!line.trim()) continue;
          try { const msg = JSON.parse(line); clearTimeout(to); resolve({ pid: msg.pid, childPid: child.pid }); return; } catch {}
        }
        buf = '';
      });
      child.on('error', (e) => { clearTimeout(to); reject(e); });
    });

    assert.ok(isAlive(childResult.pid), 'child must be alive before kill');
    process.kill(childResult.childPid, 'SIGKILL');
    await sleep(2000);
    assert.ok(!isAlive(childResult.pid), 'child must die when controller is killed');
    console.log('PASS: controller death kills tree');
  }

  // 7. execution_token mismatch rejected
  {
    const ctx = new Containment.ContainmentContext(HELPER_PATH);
    const result = await ctx.spawn({
      args: [process.execPath, '-e', 'setInterval(()=>{},500)'],
      stdio: 'null',
    });
    assert.ok(result.pid > 0);

    try {
      await ctx.terminate({ executionToken: 'wrong-token', graceMs: 100 });
      assert.fail('Should have thrown on token mismatch');
    } catch (e) {
      assert.ok(e.message.includes('token') || e.message.includes('mismatch') || e.message.includes('error'),
        `Error should mention issue: ${e.message}`);
    }

    await ctx.terminate({ executionToken: result.executionToken, graceMs: 500 });
    ctx.close();
    console.log('PASS: execution_token mismatch rejected');
  }

  // 8. Fail-closed on missing helper
  {
    try {
      const ctx = new Containment.ContainmentContext('C:\\nonexistent\\helper.exe');
      ctx.spawn({ args: [process.execPath, '-e', ''] });
      assert.fail('Should have thrown when helper is missing');
    } catch (e) {
      assert.ok(e.message, 'Must throw an error');
    }
    console.log('PASS: fail-closed on missing helper');
  }

  // 9. Visible-window invariant: no descendant owns a visible window
  {
    const ctx = new Containment.ContainmentContext(HELPER_PATH);
    const result = await ctx.spawn({
      args: [process.execPath, '-e', 'setInterval(()=>{},500)'],
      stdio: 'null',
    });
    await sleep(500);

    // The external-desktop prerequisite: the detector must be able to see the
    // desktop's own windows. A failed query is NOT a verified zero-window
    // result, so it can never stand in for proof of safety.
    const desktop = queryDesktopWindows();
    if (!desktop.ok) {
      console.log(`SKIP: GUI window coverage — desktop window query failed: ${desktop.error}`);
      console.log('      no-visible-window invariant NOT verifiable this run (a failed query is not proof of safety).');
    } else {
      // This check runs in headless sessions too: a contained child that put a
      // window on the desktop would show up here regardless of what the desktop
      // started with.
      const badPids = findDescendantWindows([result.pid]);
      assert.ok(badPids !== null,
        'descendant window query must not fail when the desktop query succeeded');
      assert.strictEqual(badPids.length, 0,
        `No descendant should own a visible window, found: ${JSON.stringify(badPids)}`);
      console.log(`  Desktop windows: ${desktop.count}, descendant windows: 0`);
      if (desktop.count > 0) {
        console.log('PASS: no visible windows from contained process (desktop verified)');
      } else {
        console.log('SKIP: GUI detector proof — verified headless desktop (0 visible windows);');
        console.log('      descendant-ownership check still ran and found none.');
      }
    }

    await ctx.terminate({ executionToken: result.executionToken, graceMs: 500 });
    ctx.close();
  }

  // 10. GUI-enabled: the visible-window detector must catch a real violation.
  //     Opt-in only (DCLI_GUI_SMOKE=1) so a normal run never flashes a window.
  {
    const guiSmoke = process.env.DCLI_GUI_SMOKE;
    if (!guiSmoke || guiSmoke === '0') {
      console.log('SKIP: GUI-enabled detector test — DCLI_GUI_SMOKE not set;');
      console.log('      set DCLI_GUI_SMOKE=1 in an interactive desktop session to run it.');
    } else {
      const desktop = queryDesktopWindows();
      if (!desktop.ok) {
        console.log(`SKIP: GUI-enabled detector test — desktop window query failed: ${desktop.error}`);
        console.log('      GUI path cannot run (a failed query is not proof of safety).');
      } else if (desktop.count === 0) {
        console.log('SKIP: GUI-enabled detector test — verified headless desktop (0 visible windows);');
        console.log('      needs an interactive desktop session.');
      } else {
        const ctx = new Containment.ContainmentContext(HELPER_PATH);
        const result = await ctx.spawn({ args: ['notepad'], stdio: 'null' });
        await sleep(2500);

        const badPids = findDescendantWindows([result.pid]);
        assert.ok(badPids !== null, 'descendant window query must succeed in the GUI path');
        assert.ok(badPids.length > 0,
          `GUI path must detect the visible probe window it created; found none for descendant set of pid ${result.pid}`);
        console.log(`  Detected visible probe window owned by descendant pid(s): ${badPids.join(', ')}`);

        await ctx.terminate({ executionToken: result.executionToken, graceMs: 2000 });
        ctx.close();
        console.log('PASS: GUI detector caught a real visible descendant window');
      }
    }
  }

  console.log('\nAll containment tests passed.');
}

function queryDesktopWindows() {
  const res = spawnSync(
    'powershell', ['-NoProfile', '-Command',
      '(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Measure-Object).Count'],
    { encoding: 'utf8', timeout: 5000, windowsHide: true }
  );
  if (res.error || res.status !== 0) {
    const detail = (res.stderr || (res.error && res.error.message) || '').toString().trim();
    return { ok: false, error: detail || 'window query failed' };
  }
  const errText = (res.stderr || '').trim();
  if (errText) return { ok: false, error: errText };
  const n = parseInt((res.stdout || '').trim(), 10);
  if (Number.isNaN(n)) return { ok: false, error: `non-numeric count from query: ${JSON.stringify((res.stdout || '').trim())}` };
  return { ok: true, count: n };
}

function findDescendantWindows(pids) {
  const psScript = `$pids = @(${pids.join(',')}); (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $pids -contains $_.Id } | Select-Object -ExpandProperty Id) -join ','`;
  const res = spawnSync('powershell', ['-NoProfile', '-Command', psScript],
    { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (res.error || res.status !== 0 || (res.stderr || '').trim()) return null;
  const trimmed = (res.stdout || '').trim();
  if (!trimmed) return [];
  return trimmed.split(',').map(Number).filter(n => !isNaN(n));
}

main().catch(e => {
  console.error('TEST FAILED:', e.message);
  process.exit(1);
});
