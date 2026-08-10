const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { DEFAULT_TIMEOUT } = require('../run-tests');

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: DEFAULT_TIMEOUT,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function createGitRepoTemplate(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  runGit(['init', '-b', 'main'], repo);
  fs.appendFileSync(
    path.join(repo, '.git', 'config'),
    '[user]\n\temail = test@test.com\n\tname = Test\n[commit]\n\tgpgSign = false\n',
    'utf8',
  );

  return {
    copyTo(target) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(repo, target, { recursive: true });
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

module.exports = { createGitRepoTemplate };
