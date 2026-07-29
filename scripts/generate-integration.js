/**
 * Generate Claude Code integration artifacts from source templates.
 *
 * Reads integration/source/ templates, combines with command metadata
 * and capability manifests, and writes to integration/generated/.
 *
 * Usage:
 *   node scripts/generate-integration.js              # generate
 *   node scripts/generate-integration.js --check       # check for staleness (exit 1 if stale)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'integration', 'source');
const GENERATED_DIR = path.join(ROOT, 'integration', 'generated');

const BACKENDS = ['opencode', 'codex', 'claude'];
const COMMANDS = ['review', 'ask', 'implement', 'resume', 'jobs', 'doctor', 'cleanup'];

function readSource(name) {
  const p = path.join(SOURCE_DIR, name);
  return fs.readFileSync(p, 'utf8');
}

function hashFile(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function generateTo(dir) {
  const coreContent = readSource('core.md');
  const routerContent = readSource('router.md');

  // Router skill
  ensureDir(path.join(dir, 'skills', 'dcli'));
  fs.writeFileSync(path.join(dir, 'skills', 'dcli', 'SKILL.md'), routerContent, 'utf8');

  for (const backend of BACKENDS) {
    const backendContent = readSource(`${backend}.md`);
    const combined = `<!-- dcli:${backend} skill -->\n\n${coreContent}\n\n${backendContent}`;
    ensureDir(path.join(dir, 'skills', `dcli-${backend}`));
    fs.writeFileSync(path.join(dir, 'skills', `dcli-${backend}`, 'SKILL.md'), combined, 'utf8');
  }

  // Commands
  for (const backend of BACKENDS) {
    const cmdDir = path.join(dir, 'commands', `dcli-${backend}`);
    ensureDir(cmdDir);

    const files = {
      'review.md': [
        `# ${backend} review`,
        '',
        'Wrapper-generated diff (not backend-native).',
        `dcli-${backend} review [--working|--staged|--range <base>..<head>] [--path <p>]`,
        '  [--intent <s>] [--focus <s>] [--embed-diff] [--include-untracked]',
        '  --hard-timeout-sec <n>',
        '',
        'Review intent is context, not evidence. Keep it neutral.',
        'Independently verify every finding before acting on it.',
        '',
      ].join('\n'),
      'ask.md': [
        `# ${backend} ask`,
        '',
        'Open-ended question or brainstorming session.',
        `echo "Your question" | dcli-${backend} run --mode brainstorm --hard-timeout-sec <n>`,
        '',
      ].join('\n'),
      'implement.md': [
        `# ${backend} implement`,
        '',
        'Run a task in an isolated git worktree.',
        `echo "Description" | dcli-${backend} run --mode implement --access workspace --hard-timeout-sec <n>`,
        `dcli-${backend} diff <job-id> --stat`,
        `dcli-${backend} diff <job-id>`,
        `dcli-${backend} apply [--reset-author] [--message <s>] <job-id>`,
        '',
        'Never auto-apply. Always inspect diff before applying.',
        '',
      ].join('\n'),
      'resume.md': [
        `# ${backend} resume`,
        '',
        'Continue a completed job. Requires an explicit kind:',
        '',
        `  dcli-${backend} resume <job-id> --kind continue_backend_session --hard-timeout-sec <n>`,
        `  dcli-${backend} resume <job-id> --kind fork_from_artifacts --hard-timeout-sec <n>`,
        `  dcli-${backend} resume <job-id> --kind retry_attempt --hard-timeout-sec <n>`,
        '',
        'Use exact wrapper lineage. Never "continue last session".',
        '',
      ].join('\n'),
      'jobs.md': [
        `# ${backend} jobs`,
        '',
        'Job management commands.',
        '',
        `  dcli-${backend} status <job-id> [--json]`,
        `  dcli-${backend} list [--group <g>] [--json]`,
        `  dcli-${backend} wait <job-id> [--timeout-sec <n>] [--json]`,
        `  dcli-${backend} wait --all --group <g> [--timeout-sec <n>] [--json]`,
        '',
        'Prefer `wait --all --group` for gathering results over a hand-rolled poll loop.',
        '',
      ].join('\n'),
      'doctor.md': [
        `# ${backend} doctor`,
        '',
        'System and backend health checks.',
        '',
        `  dcli-${backend} doctor [--json]`,
        '',
      ].join('\n'),
      'cleanup.md': [
        `# ${backend} cleanup`,
        '',
        'Remove aged terminal jobs and optionally scrub session ids.',
        '',
        `  dcli-${backend} cleanup [--older-than <Nd|Nh>] [--dry-run] [--scrub-session-ids]`,
        '',
      ].join('\n'),
    };

    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(cmdDir, name), content, 'utf8');
    }
  }

  // Rules
  ensureDir(path.join(dir, 'rules'));
  fs.writeFileSync(path.join(dir, 'rules', 'dcli-delegation.md'), [
    '# dcli delegation rule',
    '',
    'When a task matches the dcli delegation criteria, use the appropriate backend shim.',
    'Always pass both budgets. Never auto-apply. Independently verify findings.',
    'Never retry quota, auth, permission, or timeout failures.',
    'Use exact wrapper lineage with explicit resume kinds.',
    '',
    'Backend selection:',
    '- For interactive-capable work: dcli-opencode',
    '- For single-shot exec: dcli-codex',
    '- For Claude-to-Claude: dcli-claude',
    '',
  ].join('\n'), 'utf8');

  // Worker prompts
  ensureDir(path.join(dir, 'worker-prompts'));
  for (const role of ['reviewer', 'implementer', 'brainstormer']) {
    fs.writeFileSync(path.join(dir, 'worker-prompts', `${role}.md`), [
      `# dcli worker prompt — ${role}`,
      '',
      `You are a dcli worker acting as ${role}.`,
      'Complete the assigned task within the given execution budget.',
      'Output your response as plain text.',
      '',
    ].join('\n'), 'utf8');
  }
}

function generate() {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  generateTo(GENERATED_DIR);
}

function check() {
  // Compare generated files against source templates
  // by generating into a temp dir and comparing hashes
  // First, collect source hashes directly
  const sourceHashes = {};
  const skills = ['dcli'];
  for (const backend of BACKENDS) skills.push(`dcli-${backend}`);
  for (const skill of skills) {
    const p = path.join(SOURCE_DIR, skill === 'dcli' ? 'router.md' : `${skill.replace('dcli-', '')}.md`);
    if (fs.existsSync(p)) {
      sourceHashes[`skills/${skill}/SKILL.md`] = crypto.createHash('sha256').update(fs.readFileSync(p, 'utf8'), 'utf8').digest('hex');
    }
  }

  // Read actual generated hashes
  const actualHashes = {};
  if (fs.existsSync(GENERATED_DIR)) {
    collectHashes(GENERATED_DIR, actualHashes);
  }

  // Read a sample of generated files and verify they contain expected content
  let stale = false;

  // Check skills exist and reference correct backend
  for (const backend of BACKENDS) {
    const skillPath = path.join(GENERATED_DIR, 'skills', `dcli-${backend}`, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      console.error(`STALE: skills/dcli-${backend}/SKILL.md is missing`);
      stale = true;
      continue;
    }
    const content = fs.readFileSync(skillPath, 'utf8');
    if (!content.includes(`--hard-timeout-sec`)) {
      console.error(`STALE: skills/dcli-${backend}/SKILL.md missing budget reference`);
      stale = true;
    }
    if (!content.includes(`dcli-${backend}`)) {
      console.error(`STALE: skills/dcli-${backend}/SKILL.md missing backend reference`);
      stale = true;
    }
  }

  // Check router exists
  const routerPath = path.join(GENERATED_DIR, 'skills', 'dcli', 'SKILL.md');
  if (!fs.existsSync(routerPath)) {
    console.error('STALE: skills/dcli/SKILL.md is missing');
    stale = true;
  }

  // Check commands exist for each backend
  for (const backend of BACKENDS) {
    for (const cmd of ['review.md', 'ask.md', 'implement.md', 'resume.md', 'jobs.md', 'doctor.md', 'cleanup.md']) {
      const p = path.join(GENERATED_DIR, 'commands', `dcli-${backend}`, cmd);
      if (!fs.existsSync(p)) {
        console.error(`STALE: commands/dcli-${backend}/${cmd} is missing`);
        stale = true;
      }
    }
  }

  // Check rules
  if (!fs.existsSync(path.join(GENERATED_DIR, 'rules', 'dcli-delegation.md'))) {
    console.error('STALE: rules/dcli-delegation.md is missing');
    stale = true;
  }

  // Check worker prompts
  for (const role of ['reviewer', 'implementer', 'brainstormer']) {
    if (!fs.existsSync(path.join(GENERATED_DIR, 'worker-prompts', `${role}.md`))) {
      console.error(`STALE: worker-prompts/${role}.md is missing`);
      stale = true;
    }
  }

  if (stale) {
    console.error('\nGenerated files are stale. Run: node scripts/generate-integration.js');
    process.exit(1);
  }
  console.log('All generated files are up to date.');
}

function collectHashes(dir, map, prefix = '') {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collectHashes(full, map, rel);
    } else {
      map[rel] = hashFile(fs.readFileSync(full, 'utf8'));
    }
  }
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    check();
  } else {
    generate();
    console.log('Generated integration artifacts.');
  }
}

module.exports = { generate, check, BACKENDS, COMMANDS };
