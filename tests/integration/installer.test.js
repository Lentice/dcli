// @suite full
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const INSTALLER = path.join(REPO_ROOT, 'install.ps1');
const GENERATED_DIR = path.join(REPO_ROOT, 'integration', 'generated');
const DCLI_MARKER = '.dcli-installed';

// Every installer run in this file names its targets explicitly. With -Force
// and no -Targets the installer installs BOTH targets, which for the `agents`
// one would mean writing into the developer's real ~\.agents while the suite
// runs. A test must never touch a target it did not create.
function runInstaller(args) {
  return spawnSync('pwsh', ['-NoProfile', '-File', INSTALLER, ...args, '-Force'], {
    encoding: 'utf8',
  });
}

// Every file under a given set of generated subtrees, as paths relative to
// integration\generated.
function generatedFiles(subtrees) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(GENERATED_DIR, full));
    }
  };
  for (const subtree of subtrees) {
    const p = path.join(GENERATED_DIR, subtree);
    if (fs.existsSync(p)) walk(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Installer refuses a directory colliding with the state root
// ---------------------------------------------------------------------------
{
  const stateRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'dcli')
    : null;

  if (!stateRoot) {
    console.log('SKIP: state-root collision test needs LOCALAPPDATA');
  } else {
    // Exactly the state root, and a path nested inside it: both must refuse.
    for (const dir of [stateRoot, path.join(stateRoot, 'nested')]) {
      const result = runInstaller(['-Targets', 'claude', '-InstallDir', dir]);
      assert.notStrictEqual(result.status, 0, `Installer must refuse install dir ${dir} colliding with state root`);
      assert.match(
        `${result.stdout}${result.stderr}`,
        /collides with state root/,
        'Refusal must name the state-root collision'
      );
      assert.ok(!fs.existsSync(path.join(dir, DCLI_MARKER)), 'Marker must not be written on refusal');
    }

    // The same guard must cover the agents target, not just the claude one.
    const agentsResult = runInstaller(['-Targets', 'agents', '-AgentsDir', path.join(stateRoot, 'skills')]);
    assert.notStrictEqual(agentsResult.status, 0, 'Installer must refuse an agents dir colliding with state root');
    assert.match(`${agentsResult.stdout}${agentsResult.stderr}`, /collides with state root/);
  }
}

// ---------------------------------------------------------------------------
// 2a. Installer SUCCEEDS against a directory that already holds unrelated
//     foreign content outside the paths dcli writes to (e.g. a real, in-use
//     ~\.claude with settings.json / memory\ / agents\ / CLAUDE.md). This is
//     the common case for every real user and must not be refused.
// ---------------------------------------------------------------------------
{
  const targetDir = path.join(os.tmpdir(), 'dcli-real-home-' + Date.now());
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'settings.json'), '{}', 'utf8');
    fs.mkdirSync(path.join(targetDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'memory', 'MEMORY.md'), '# memory', 'utf8');
    fs.mkdirSync(path.join(targetDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'CLAUDE.md'), '# instructions', 'utf8');
    // rules\ is a SHARED directory dcli does not own outright (e.g. it may
    // already hold an unrelated rules\context7.md) -- only the specific
    // generated rule file (rules\dcli-delegation.md) is dcli's concern.
    fs.mkdirSync(path.join(targetDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'rules', 'context7.md'), '# unrelated rule', 'utf8');

    const result = runInstaller(['-Targets', 'claude', '-InstallDir', targetDir]);

    assert.strictEqual(result.status, 0, `Installer must succeed against unrelated foreign content: ${result.stderr}`);
    assert.ok(fs.existsSync(path.join(targetDir, 'settings.json')), 'Unrelated settings.json must survive install');
    assert.ok(fs.existsSync(path.join(targetDir, 'memory', 'MEMORY.md')), 'Unrelated memory\\ must survive install');
    assert.ok(fs.existsSync(path.join(targetDir, 'CLAUDE.md')), 'Unrelated CLAUDE.md must survive install');
    assert.ok(fs.existsSync(path.join(targetDir, 'rules', 'context7.md')), 'Unrelated rules\\context7.md must survive install');
    assert.strictEqual(
      fs.readFileSync(path.join(targetDir, 'rules', 'context7.md'), 'utf8'),
      '# unrelated rule',
      'Unrelated rules\\context7.md content must be untouched'
    );
    assert.ok(fs.existsSync(path.join(targetDir, DCLI_MARKER)), 'Marker file must be written');
    assert.ok(fs.existsSync(path.join(targetDir, 'skills', 'dcli')), 'dcli skill dir must be installed');
    assert.ok(fs.existsSync(path.join(targetDir, 'rules', 'dcli-delegation.md')), 'dcli rule file must be installed');
  } finally {
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 2b. Installer REFUSES when a specific file it is about to write already
//     exists with foreign, non-dcli content and no marker proves prior dcli
//     ownership -- checked at the exact generated-file path, not directory
//     level.
// ---------------------------------------------------------------------------
{
  const targetDir = path.join(os.tmpdir(), 'dcli-scoped-conflict-' + Date.now());
  try {
    fs.mkdirSync(path.join(targetDir, 'skills', 'dcli'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'skills', 'dcli', 'SKILL.md'), 'not ours', 'utf8');

    const result = runInstaller(['-Targets', 'claude', '-InstallDir', targetDir]);

    assert.notStrictEqual(result.status, 0, 'Installer must refuse a foreign file at a generated path without the marker');
    assert.ok(!fs.existsSync(path.join(targetDir, DCLI_MARKER)), 'Marker must not be written on refusal');
  } finally {
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 2c. Installer REFUSES when only the shared rules\ directory has a foreign
//     file at the exact same relative path dcli would write (not the whole
//     rules\ dir being non-empty -- an unrelated sibling rule file there must
//     never trigger this).
// ---------------------------------------------------------------------------
{
  const targetDir = path.join(os.tmpdir(), 'dcli-rules-conflict-' + Date.now());
  try {
    fs.mkdirSync(path.join(targetDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'rules', 'dcli-delegation.md'), 'not ours', 'utf8');

    const result = runInstaller(['-Targets', 'claude', '-InstallDir', targetDir]);

    assert.notStrictEqual(result.status, 0, 'Installer must refuse a foreign rules\\dcli-delegation.md without the marker');
    assert.ok(!fs.existsSync(path.join(targetDir, DCLI_MARKER)), 'Marker must not be written on refusal');
  } finally {
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 2d. The same scoped foreign-content guard must protect the agents target.
// ---------------------------------------------------------------------------
{
  const agentsDir = path.join(os.tmpdir(), 'dcli-agents-conflict-' + Date.now());
  try {
    // ~\.agents\skills legitimately holds many other tools' skills; those must
    // not block an install. Only a collision at dcli's own path does.
    fs.mkdirSync(path.join(agentsDir, 'skills', 'someone-elses-skill'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'skills', 'someone-elses-skill', 'SKILL.md'), 'theirs', 'utf8');

    const ok = runInstaller(['-Targets', 'agents', '-AgentsDir', agentsDir]);
    assert.strictEqual(ok.status, 0, `Unrelated skills must not block the agents install: ${ok.stderr}`);
    assert.ok(
      fs.existsSync(path.join(agentsDir, 'skills', 'someone-elses-skill', 'SKILL.md')),
      "Another tool's skill must survive the install"
    );
  } finally {
    try { fs.rmSync(agentsDir, { recursive: true, force: true }); } catch {}
  }
}
{
  const agentsDir = path.join(os.tmpdir(), 'dcli-agents-refuse-' + Date.now());
  try {
    fs.mkdirSync(path.join(agentsDir, 'skills', 'dcli'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'skills', 'dcli', 'SKILL.md'), 'not ours', 'utf8');

    const result = runInstaller(['-Targets', 'agents', '-AgentsDir', agentsDir]);
    assert.notStrictEqual(result.status, 0, 'Installer must refuse a foreign skills\\dcli\\SKILL.md in the agents target');
    assert.ok(!fs.existsSync(path.join(agentsDir, DCLI_MARKER)), 'Marker must not be written on refusal');
  } finally {
    try { fs.rmSync(agentsDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 3. Real install: the claude target receives the whole tree, no staging dir
//    survives, and every installed file byte-matches the repository.
// ---------------------------------------------------------------------------
{
  const targetDir = path.join(os.tmpdir(), 'dcli-claude-target-' + Date.now());
  try {
    const result = runInstaller(['-Targets', 'claude', '-InstallDir', targetDir]);
    assert.strictEqual(result.status, 0, `Installer must succeed: ${result.stderr}`);

    assert.ok(fs.existsSync(path.join(targetDir, DCLI_MARKER)), 'Marker file must exist after install');
    assert.ok(!fs.existsSync(targetDir + '.dcli-staging'), 'Staging dir must not survive a successful install');

    const subtrees = ['skills', 'commands', 'rules', 'worker-prompts'];
    for (const sub of subtrees) {
      assert.ok(fs.existsSync(path.join(targetDir, sub)), `claude target must receive ${sub}\\`);
    }
    const files = generatedFiles(subtrees);
    assert.ok(files.length > 0, 'Generated tree must not be empty');
    for (const rel of files) {
      const installed = path.join(targetDir, rel);
      assert.ok(fs.existsSync(installed), `Missing installed file: ${rel}`);
      assert.ok(
        fs.readFileSync(installed).equals(fs.readFileSync(path.join(GENERATED_DIR, rel))),
        `Installed file must byte-match the repository: ${rel}`
      );
    }
  } finally {
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(targetDir + '.dcli-staging', { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 4. The agents target receives skills ONLY. commands\ and rules\ are Claude
//    Code layouts: the Codex CLI reads ~\.agents\skills, but its custom-prompt
//    directory is flat (no dcli-<backend>\ namespace) and ~\.codex\rules holds
//    execpolicy Starlark, not agent instructions. Copying either there would
//    install files no host reads.
// ---------------------------------------------------------------------------
{
  const agentsDir = path.join(os.tmpdir(), 'dcli-agents-target-' + Date.now());
  try {
    const result = runInstaller(['-Targets', 'agents', '-AgentsDir', agentsDir]);
    assert.strictEqual(result.status, 0, `Installer must succeed for agents target: ${result.stderr}`);

    assert.ok(fs.existsSync(path.join(agentsDir, DCLI_MARKER)), 'Marker file must exist in the agents target');
    for (const skill of ['dcli', 'dcli-opencode', 'dcli-codex', 'dcli-claude']) {
      const skillPath = path.join(agentsDir, 'skills', skill, 'SKILL.md');
      assert.ok(fs.existsSync(skillPath), `agents target must receive skills\\${skill}\\SKILL.md`);
      // A skills root shared with other agent CLIs is discovered by frontmatter.
      // A skill installed without `name` and `description` is present but
      // effectively invisible to the host.
      const content = fs.readFileSync(skillPath, 'utf8');
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(content);
      assert.ok(fm, `${skill} must carry YAML frontmatter`);
      assert.match(fm[1], new RegExp(`^name:[ \\t]*${skill}$`, 'm'), `${skill} frontmatter name must match its directory`);
      assert.match(fm[1], /^description:[ \t]*\S/m, `${skill} frontmatter must carry a description`);
    }
    for (const sub of ['commands', 'rules', 'worker-prompts']) {
      assert.ok(!fs.existsSync(path.join(agentsDir, sub)), `agents target must NOT receive ${sub}\\`);
    }
  } finally {
    try { fs.rmSync(agentsDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 5. Both targets in one run, each getting its own subtree.
// ---------------------------------------------------------------------------
{
  const stamp = Date.now();
  const claudeDir = path.join(os.tmpdir(), 'dcli-both-claude-' + stamp);
  const agentsDir = path.join(os.tmpdir(), 'dcli-both-agents-' + stamp);
  try {
    const result = runInstaller([
      '-Targets', 'claude,agents',
      '-InstallDir', claudeDir,
      '-AgentsDir', agentsDir,
    ]);
    assert.strictEqual(result.status, 0, `Installer must succeed for both targets: ${result.stderr}`);

    assert.ok(fs.existsSync(path.join(claudeDir, 'commands', 'dcli-codex')), 'claude target keeps commands');
    assert.ok(fs.existsSync(path.join(agentsDir, 'skills', 'dcli-codex', 'SKILL.md')), 'agents target gets skills');
    assert.ok(!fs.existsSync(path.join(agentsDir, 'commands')), 'agents target still gets skills only');
  } finally {
    try { fs.rmSync(claudeDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(agentsDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 6. Two selected targets resolving to the same directory are refused: the
//    second install would otherwise see the first one's files as its own.
// ---------------------------------------------------------------------------
{
  const sameDir = path.join(os.tmpdir(), 'dcli-same-dir-' + Date.now());
  try {
    const result = runInstaller([
      '-Targets', 'claude,agents',
      '-InstallDir', sameDir,
      '-AgentsDir', sameDir,
    ]);
    assert.notStrictEqual(result.status, 0, 'Installer must refuse two targets sharing one directory');
    assert.match(`${result.stdout}${result.stderr}`, /same directory/, 'Refusal must name the collision');
    assert.ok(!fs.existsSync(path.join(sameDir, DCLI_MARKER)), 'Marker must not be written on refusal');
  } finally {
    try { fs.rmSync(sameDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 7. Reinstall is a swap, not a merge: a file removed in a newer version must
//    not survive in a namespaced directory dcli owns outright (AGENTS.md §9).
//    Checked on the agents target, whose only subtree is skills\.
// ---------------------------------------------------------------------------
{
  const agentsDir = path.join(os.tmpdir(), 'dcli-ghost-' + Date.now());
  try {
    assert.strictEqual(runInstaller(['-Targets', 'agents', '-AgentsDir', agentsDir]).status, 0);

    const ghost = path.join(agentsDir, 'skills', 'dcli', 'GHOST.md');
    fs.writeFileSync(ghost, 'removed in a newer version', 'utf8');

    const result = runInstaller(['-Targets', 'agents', '-AgentsDir', agentsDir]);
    assert.strictEqual(result.status, 0, `Reinstall must succeed: ${result.stderr}`);
    assert.ok(!fs.existsSync(ghost), 'A stale file in an owned skill dir must not survive reinstall');
    assert.ok(
      fs.existsSync(path.join(agentsDir, 'skills', 'dcli', 'SKILL.md')),
      'Reinstall must restore the skill it owns'
    );
  } finally {
    try { fs.rmSync(agentsDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 8. An unrecognized target is rejected, not silently discarded.
// ---------------------------------------------------------------------------
{
  const claudeDir = path.join(os.tmpdir(), 'dcli-bad-target-' + Date.now());
  const result = runInstaller(['-Targets', 'codex', '-InstallDir', claudeDir]);
  assert.notStrictEqual(result.status, 0, 'An invalid target value must be rejected');
  assert.ok(!fs.existsSync(claudeDir), 'Nothing may be written when the target is invalid');
}

console.log('All installer tests passed.');
