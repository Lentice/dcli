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
  };
}

/**
 * Build a Windows command-line string from an argv array.
 * Arguments containing spaces or tabs are wrapped in double quotes.
 *
 * @param {string[]} parts - Command and argument array
 * @returns {string} Windows command-line string
 */
function buildWin32CommandLine(parts) {
  return parts.map(part => {
    if (part === '' || /[\s]/.test(part)) {
      return '"' + part.replace(/"/g, '\\"') + '"';
    }
    return part;
  }).join(' ');
}

module.exports = { quoteForCmd, buildCmdInvocation, buildWin32CommandLine, CMD_METACHARS };
