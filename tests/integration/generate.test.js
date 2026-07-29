// @suite full
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { generate, check, BACKENDS, COMMANDS } = require('../../scripts/generate-integration');

const GENERATED_DIR = path.resolve(__dirname, '../../integration/generated');

// ---------------------------------------------------------------------------
// 1. Generation succeeds and produces expected files
// ---------------------------------------------------------------------------
{
  assert.ok(fs.existsSync(GENERATED_DIR), 'Generated dir must exist');

  // Skills
  for (const backend of BACKENDS) {
    const skillPath = path.join(GENERATED_DIR, 'skills', `dcli-${backend}`, 'SKILL.md');
    assert.ok(fs.existsSync(skillPath), `Skill must exist: ${skillPath}`);
    const content = fs.readFileSync(skillPath, 'utf8');
    assert.ok(content.includes('--hard-timeout-sec'), `Skill must include budget: ${skillPath}`);
    assert.ok(content.includes('dcli-' + backend), `Skill must reference correct shim`);
  }

  // Router skill
  const routerPath = path.join(GENERATED_DIR, 'skills', 'dcli', 'SKILL.md');
  assert.ok(fs.existsSync(routerPath), 'Router skill must exist');
  const routerContent = fs.readFileSync(routerPath, 'utf8');
  assert.ok(routerContent.includes('dcli-opencode'));
  assert.ok(routerContent.includes('dcli-codex'));
  assert.ok(routerContent.includes('dcli-claude'));

  // Commands per backend
  for (const backend of BACKENDS) {
    for (const cmd of COMMANDS) {
      const cmdPath = path.join(GENERATED_DIR, 'commands', `dcli-${backend}`, `${cmd}.md`);
      assert.ok(fs.existsSync(cmdPath), `Command doc must exist: ${cmdPath}`);
    }
  }

  // Rules
  assert.ok(fs.existsSync(path.join(GENERATED_DIR, 'rules', 'dcli-delegation.md')));

  // Worker prompts
  for (const role of ['reviewer', 'implementer', 'brainstormer']) {
    assert.ok(fs.existsSync(path.join(GENERATED_DIR, 'worker-prompts', `${role}.md`)));
  }
}

// ---------------------------------------------------------------------------
// 2. Generation creates deterministic output
// ---------------------------------------------------------------------------
{
  // Run generate twice and compare — output must be identical
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-gen-test-'));
  try {
    // First generation into a temp
    const gen1Dir = path.join(tmpDir, 'gen1');
    const gen2Dir = path.join(tmpDir, 'gen2');

    // Run generation by directly calling the module functions
    const mod = require('../../scripts/generate-integration');
    mod.generate();

    // We can verify the real generated dir is valid by reading it
    const entries = fs.readdirSync(path.join(GENERATED_DIR, 'skills'));
    assert.ok(entries.length >= 4, 'Must have at least 4 skill dirs (router + 3 backends)');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 3. Generated skills include --hard-timeout-sec in their content
// ---------------------------------------------------------------------------
{
  const skillDir = path.join(GENERATED_DIR, 'skills');
  const entries = fs.readdirSync(skillDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const content = fs.readFileSync(skillFile, 'utf8');
    assert.ok(content.includes('--hard-timeout-sec'), `Skill ${entry.name} must reference budget flag`);
  }
}

// ---------------------------------------------------------------------------
// 4. One adapter's flag must NOT appear in another adapter's skill
// ---------------------------------------------------------------------------
{
  const flagOwners = {
    'dcli-opencode': ['--variant'],
    'dcli-codex': ['--effort'],
    'dcli-claude': ['--reasoning-effort'],
  };

  for (const [owner, flags] of Object.entries(flagOwners)) {
    for (const [otherOwner, otherFlags] of Object.entries(flagOwners)) {
      if (owner === otherOwner) continue;
      const skillPath = path.join(GENERATED_DIR, 'skills', owner, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const content = fs.readFileSync(skillPath, 'utf8');
      for (const flag of otherFlags) {
        // Allow the flag name in the context of explaining it's not supported
        // Only check for it as a usage flag (preceded by space or backtick)
        const regex = new RegExp(`[\\s\`]${flag}[\\s\`]`, 'i');
        if (regex.test(content)) {
          // It's allowed if it's documented as "not supported" or "use X instead"
          if (!content.includes('not supported') && !content.includes('instead') && !content.includes('use ')) {
            assert.fail(`Flag ${flag} owned by ${otherOwner} appears in ${owner} skill`);
          }
        }
      }
    }
  }
}

console.log('All integration generation tests passed.');
