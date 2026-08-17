const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { DEFAULT_TIMEOUT } = require('../run-tests');

const {
  ensureStateRoot,
  assertStateRootWritable,
  getStateRootAcl,
  resetCache,
} = require('../../core/state-root');

function tmpDir() {
  return path.join(os.tmpdir(), `dcli-acl-test-${Math.random().toString(36).slice(2)}`);
}

function clean(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ===========================================================================
// 1. ensureStateRoot creates directory and sets owner-only ACLs
// ===========================================================================

{
  const testDir = tmpDir();
  try {
    ensureStateRoot(testDir);
    assert.ok(fs.existsSync(testDir), 'State root directory must exist');

    const acl = getStateRootAcl(testDir);
    assert.ok(acl !== null, 'getStateRootAcl must return a value');
    assert.strictEqual(typeof acl, 'string', 'ACL must be a string');

    if (process.platform === 'win32') {
      // icacls output format contains user permissions
      const lower = acl.toLowerCase();

      // Most critical: Everyone must never have access
      assert.ok(
        !lower.includes('everyone'),
        'icacls must not grant access to Everyone'
      );

      if (lower.includes('authenticated users')) {
        const authLines = acl.split('\n').filter(l => l.toLowerCase().includes('authenticated users'));
        for (const line of authLines) {
          assert.ok(
            !/\(OI\)\(CI\)(?:\(F\)|F)/.test(line.toUpperCase()),
            `Authenticated Users must not have full control: ${line.trim()}`
          );
        }
      }

      // Verify current user has (OI)(CI)F
      const whoami = spawnSync('whoami', [], { timeout: DEFAULT_TIMEOUT, encoding: 'utf8', windowsHide: true });
      const user = whoami.stdout ? whoami.stdout.trim() : '';
      if (user) {
        const lower = acl.toLowerCase();
        const userLine = lower.split('\n').find(l => l.includes(user.toLowerCase()));
        assert.ok(userLine, `icacls output must contain current user "${user}", got: ${acl}`);
        assert.ok(
          /\(OI\)\(CI\)(?:\(F\)|F)/.test(userLine.toUpperCase()),
          `Current user must have (OI)(CI)F, got: ${userLine.trim()}`
        );
      }
    } else {
      // POSIX: mode must be 0o700 (owner rwx only)
      const stat = fs.statSync(testDir);
      const mode = stat.mode & 0o777;
      assert.strictEqual(
        mode, 0o700,
        `State root mode must be 0o700, got 0${mode.toString(8)}`
      );
    }

    console.log('PASS: state root created with owner-only ACLs');
  } finally {
    clean(testDir);
  }
}

// ===========================================================================
// 2. getStateRootAcl returns null for non-existent path with no cached root
// ===========================================================================

{
  resetCache();
  const result = getStateRootAcl();
  assert.strictEqual(result, null, 'getStateRootAcl without path and no cache must return null');
  console.log('PASS: getStateRootAcl returns null without cache');
}

// ===========================================================================
// 3. A failed writability probe is actionable and classified
// ===========================================================================

{
  const testDir = tmpDir();
  fs.mkdirSync(testDir, { recursive: true });
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (filePath, ...args) => {
    if (String(filePath).includes('.dcli-probe-')) {
      const err = new Error('sandbox denied the probe write');
      err.code = 'EPERM';
      throw err;
    }
    return originalWriteFileSync(filePath, ...args);
  };

  try {
    assert.throws(
      () => assertStateRootWritable(testDir),
      (err) => {
        assert.strictEqual(err.code, 'DCLI_STATE_ROOT_UNWRITABLE');
        assert.strictEqual(err.reason, 'state_root_unwritable');
        assert.strictEqual(err.failureClass, 'permission_or_sandbox');
        assert.strictEqual(err.exitCode, 15);
        assert.match(err.message, /state root not writable/i);
        assert.ok(err.message.includes(testDir));
        assert.match(err.message, /DCLI_STATE_ROOT/);
        return true;
      }
    );
    console.log('PASS: state-root writability failure is actionable');
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    clean(testDir);
  }
}

console.log('\nAll state-root ACL tests passed.');
