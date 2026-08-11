// Probe runner shared by the adapters' version/doctor probes.
//
// The probes sit at a trust boundary (they run at setup, install verification
// and doctor), so they must build their invocation exactly like the launch
// path does — argument arrays, never a shell string — and never by
// interpolating an executable path into a command string. A path containing
// spaces or cmd metacharacters (`&`, `(`, `)`, ...) is misparsed by cmd.exe /
// /bin/sh when it is embedded in a command string.

const { spawnSync } = require('node:child_process');
const { buildWin32CommandLine } = require('../codex/cmd-quoting');

/**
 * Run `command args` synchronously as an argument array.
 *
 * - Non-`.cmd` executables spawn directly.
 * - `.cmd`/`.bat` shims go through `cmd.exe /d /s /c` with the inner command
 *   line built by the shared `buildWin32CommandLine` and passed as a single
 *   `/c` argument (wrapped so `/s` strips exactly the outer quote pair). This
 *   is the launch path's construction minus the `quoteForCmd` layer, which
 *   would otherwise corrupt a metacharacter inside the quoted shim path.
 *
 * Returns the child's stdout as a string (mirroring `execSync` with
 * `encoding: 'utf8'`). Throws on spawn failure or non-zero exit, so callers'
 * detection/verdict handling is unchanged.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {string}
 */
function runProbe(command, args, timeoutMs) {
  if (/\.(cmd|bat)$/i.test(command)) {
    const comSpec = process.env.ComSpec || 'cmd.exe';
    return runSpawn(comSpec, ['/d', '/s', '/c', `"${buildWin32CommandLine([command, ...args])}"`], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      // The inner command line is pre-built above; without this the runtime
      // would re-quote it (escaping the inner quotes as \") and cmd.exe would
      // receive a mangled program name. The launch path forwards this field
      // for the same reason.
      windowsVerbatimArguments: true,
    });
  }
  return runSpawn(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
}

function runSpawn(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
  return result.stdout;
}

module.exports = { runProbe };
