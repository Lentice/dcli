// Shared cmd.exe quoting utility — must be the single implementation used by
// both the codex adapter and the Windows detach path (containment helper).
//
// Two-layered quoting rule:
//   1. Win32 quoting of each argument (spaces → double-quote wrapping)
//   2. Force-quoting of cmd metacharacters: & | < > ( ) ^ %

const CMD_METACHARS = new Set(['&', '|', '<', '>', '(', ')', '^', '%']);

/**
 * Escape cmd metacharacters in a Windows command-line string by prefixing
 * each metacharacter with ^.
 *
 * @param {string} str - Input string (already Win32-quoted)
 * @returns {string} String with metacharacters ^-escaped
 */
function quoteForCmd(str) {
  let result = '';
  for (const ch of str) {
    if (CMD_METACHARS.has(ch)) {
      result += '^' + ch;
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Build a spawn invocation for a Windows command, wrapping .cmd/.bat shims
 * in cmd.exe /d /s /c with proper quoting.
 *
 * For non-.cmd/.bat binaries (e.g. .exe) the invocation is passed through
 * unchanged except for windowsHide: true.
 *
 * @param {object} opts
 * @param {string} opts.command - Resolved binary path
 * @param {string[]} opts.args - Argument array for the target command
 * @param {string} [opts.cwd] - Working directory
 * @param {Record<string,string>} [opts.env] - Environment variables
 * @returns {{ command: string, args: string[], cwd?: string, env?: Record<string,string>, windowsHide: boolean, stdio?: string[] }}
 */
function buildCmdInvocation(opts) {
  const { command, args, cwd, env } = opts;
  const isCmdShim = /\.(cmd|bat)$/i.test(command);

  if (!isCmdShim) {
    return {
      command,
      args: [...args],
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
      windowsHide: true,
    };
  }

  // Build the inner Win32 command line from the shim path and its arguments
  const allParts = [command, ...args];
  const win32Line = buildWin32CommandLine(allParts);

  // Escape cmd metacharacters for the inner line
  const escapedInner = quoteForCmd(win32Line);

  // Wrap in quotes for /s processing (cmd /s strips the outer quotes)
  const comSpec = process.env.ComSpec || 'cmd.exe';

  return {
    command: comSpec,
    args: ['/d', '/s', '/c', '"' + escapedInner + '"'],
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    windowsHide: true,
    // Both quoting layers are already applied above, so the runtime must not
    // apply a third. Without this, child_process.spawn re-quotes the
    // pre-quoted inner line, cmd.exe receives literal \" characters, and it
    // reports the entire command line as an unrecognized program name — the
    // shim never runs, while the launch still looks successful from the
    // parent (a live pid, no throw, no EINVAL). Callers MUST forward this
    // field to spawn; see the cmd-shim contract tests.
    windowsVerbatimArguments: true,
  };
}

/**
 * Build a Windows command-line string from an argv array, using the
 * correct CommandLineToArgvW-compatible algorithm.
 *
 * For each argument:
 * - If empty or contains spaces/tabs, wrap in double quotes.
 * - Inside quotes, embedded quotes are escaped as \" but backslash
 *   runs preceding a quote or at the end of a quoted argument are
 *   doubled to match what CommandLineToArgvW expects.
 *
 * @param {string[]} parts - Command and argument array
 * @returns {string} Windows command-line string
 */
function buildWin32CommandLine(parts) {
  return parts.map(part => {
    if (part === '' || /[\s]/.test(part)) {
      let result = '"';
      let i = 0;
      while (i < part.length) {
        let backslashCount = 0;
        while (i < part.length && part[i] === '\\') {
          backslashCount++;
          i++;
        }
        if (i >= part.length) {
          result += '\\'.repeat(backslashCount * 2);
        } else if (part[i] === '"') {
          result += '\\'.repeat(backslashCount * 2 + 1) + '"';
          i++;
        } else {
          result += '\\'.repeat(backslashCount) + part[i];
          i++;
        }
      }
      result += '"';
      return result;
    }
    return part;
  }).join(' ');
}

module.exports = { quoteForCmd, buildCmdInvocation, buildWin32CommandLine, CMD_METACHARS };
