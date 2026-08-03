const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DISCOVERY_TIMEOUT_MS = 5000;
const MAX_BUFFER_BYTES = 300 * 1024 * 1024;
const DISCOVERY_SCRIPT = [
  "const fs=require('node:fs'),path=require('node:path');",
  "const input=JSON.parse(process.argv[1]),out=[],timer=setTimeout(()=>process.exit(124),input.timeoutMs);",
  "(async()=>{for(const entry of input.entries)for(const name of input.names){const candidate=path.resolve(entry,name);",
  "try{const stat=await fs.promises.stat(candidate);if(!stat.isFile())continue;",
  "if(process.platform!=='win32')await fs.promises.access(candidate,fs.constants.X_OK);out.push(candidate)}catch{}}",
  "clearTimeout(timer);process.stdout.write(out.join('\\0'));})().catch(()=>process.exit(1));",
].join('');

function executableNames(command) {
  return process.platform === 'win32'
    ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
    : [command];
}

function discoverWithWorker(pathEntries, names) {
  try {
    const output = childProcess.execFileSync(
      process.execPath,
      ['-e', DISCOVERY_SCRIPT, JSON.stringify({
        entries: pathEntries,
        names,
        timeoutMs: DISCOVERY_TIMEOUT_MS - 100,
      })],
      {
        encoding: 'utf8',
        timeout: DISCOVERY_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
      }
    );
    return output.split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

function isExecutablePath(candidate) {
  try {
    const resolved = path.resolve(candidate);
    const entry = path.dirname(resolved);
    const name = path.basename(resolved);
    const key = path.normalize(resolved);
    return discoverWithWorker([entry], [name]).some(found => {
      const normalized = path.normalize(found);
      return (process.platform === 'win32' ? normalized.toLowerCase() : normalized) ===
        (process.platform === 'win32' ? key.toLowerCase() : key);
    });
  } catch {
    return false;
  }
}

function resolveExecutablePath({ envName, fallback, names, resolveNear }) {
  if (process.env[envName]) return process.env[envName];

  const pathEntries = [...new Set(
    [process.env.PATH, process.env.Path]
      .filter(value => value !== undefined && value !== null)
      .flatMap(value => value.split(path.delimiter))
  )];
  const discovered = discoverWithWorker(pathEntries, names);
  if (discovered.length === 0) return fallback;

  const found = new Set(discovered.map(candidate => {
    const normalized = path.normalize(candidate);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }));
  let firstBareCandidate = null;

  for (const entry of pathEntries) {
    const candidates = [];
    for (const name of names) {
      const candidate = path.resolve(entry, name);
      const normalized = path.normalize(candidate);
      const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
      if (found.has(key)) candidates.push(candidate);
    }
    if (candidates.length === 0) continue;

    const executable = process.platform !== 'win32'
      ? candidates[0]
      : candidates.find(candidate => /\.(exe|cmd|bat)$/i.test(candidate));
    if (executable) {
      if (resolveNear) {
        try {
          const resolved = resolveNear(executable);
          if (resolved && isExecutablePath(resolved)) return resolved;
        } catch {}
      }
      return executable;
    }

    const bare = candidates[0];
    if (resolveNear) {
      try {
        const resolved = resolveNear(bare);
        if (resolved && isExecutablePath(resolved)) return resolved;
      } catch {}
    }
    if (!firstBareCandidate) firstBareCandidate = bare;
  }

  return firstBareCandidate || fallback;
}

module.exports = { executableNames, resolveExecutablePath };
