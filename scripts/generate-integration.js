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
const { DEFAULTS } = require('../core/deadlines');
const WAIT_TIMEOUT_SEC = DEFAULTS.WAIT_TIMEOUT_MS / 1000;

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

// Every SKILL.md needs `name` and `description` YAML frontmatter. Both Claude
// Code and the Codex CLI discover skills by reading exactly those two keys, and
// the shared `~/.agents/skills` root is read by both. Without frontmatter the
// host falls back to the first line of the body, which is how the backend
// skills once advertised themselves to agents as "<!-- dcli:codex skill -->".
const SKILL_DESCRIPTIONS = {
  dcli: 'Route bounded cross-backend work to a coding-agent CLI and get a durable, '
    + 'inspectable result back. Use when an intentional backend boundary needs dcli.',
  opencode: 'Delegate bounded work to the opencode CLI as a different backend, running '
    + 'unattended. Use when wrapper job guarantees are needed.',
  codex: 'Delegate bounded work to the Codex CLI as a different backend and a single-shot '
    + 'exec run. Use when wrapper job guarantees are needed.',
  claude: 'Delegate bounded work to another backend. Use when cross-backend wrapper job '
    + 'guarantees are needed.',
};

function skillFrontmatter(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n`;
}

function generateTo(dir) {
  const coreContent = readSource('core.md');
  const routerContent = readSource('router.md');

  // Router skill
  ensureDir(path.join(dir, 'skills', 'dcli'));
  fs.writeFileSync(
    path.join(dir, 'skills', 'dcli', 'SKILL.md'),
    skillFrontmatter('dcli', SKILL_DESCRIPTIONS.dcli) + routerContent,
    'utf8'
  );

  for (const backend of BACKENDS) {
    const backendContent = readSource(`backend-${backend}.md`);
    const combined = skillFrontmatter(`dcli-${backend}`, SKILL_DESCRIPTIONS[backend])
      + `<!-- dcli:${backend} skill -->\n\n${coreContent}\n\n${backendContent}`;
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
        `echo "Your question" | dcli-${backend} run --hard-timeout-sec <n>`,
        '',
        '`run` is synchronous and the default mode; --hard-timeout-sec bounds it.',
        'The outer shell or agent tool must also have a finite timeout longer than',
        'the hard budget plus startup/cleanup slack. If it cannot, use `submit`',
        'and collect with `wait --timeout-sec <n>` instead.',
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
        'Synchronous resume also needs a finite outer caller timeout; use submit',
        'plus bounded wait when the caller cannot set one.',
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
        `  dcli-${backend} wait <job-id> --timeout-sec <n> [--json]`,
        `  dcli-${backend} wait --all --group <g> --timeout-sec <n> [--json]`,
        '',
        'Prefer `wait --all --group` for gathering results over a hand-rolled poll loop.',
        '',
        '--timeout-sec is the caller wait budget, and it is separate from the execution',
        'budget (--hard-timeout-sec) given at submit time. Documented recipes pass it',
        `explicitly; when omitted, dcli uses a ${WAIT_TIMEOUT_SEC}s fallback. Exit 20`,
        'means only that the caller budget elapsed, so the job may still be active.',
        'With --json, inspect wait_timed_out and wait_timeout_sec, then decide from',
        'the terminal state in `status`, never from a phase or progress signal.',
        '',
      ].join('\n'),
      'doctor.md': [
        `# ${backend} doctor`,
        '',
        'System and backend health checks.',
        '',
        `  dcli-${backend} doctor [--json] [--live-smoke-timeout-sec <n>]`,
        '',
      ].join('\n'),
      'cleanup.md': [
        `# ${backend} cleanup`,
        '',
        'Remove aged terminal jobs, their worktrees and git registrations,',
        'plus orphan worktrees under the dcli state root; optionally scrub',
        'session ids (durable: journaled, terminal jobs only).',
        '',
        `  dcli-${backend} cleanup [--older-than <Nd|Nh>] [--dry-run] [--scrub-session-ids]`,
        '  N must be a positive integer; d means days and h means hours.',
        '',
        'Use --dry-run first: it names each worktree and reports its bytes.',
        'Artifacts held by a reader or repository operation are named and skipped.',
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
    'Use dcli only for intentional cross-backend delegation.',
    'Its durable job guarantees do not replace a same-backend native subagent.',
    'For same-backend subagents, use the current agent backend\'s native subagent mechanism directly.',
    'Do not use the matching dcli shim as a substitute for a native subagent:',
    '- Codex native subagent → not `dcli-codex`',
    '- Claude native Task/subagent → not `dcli-claude`',
    '- opencode native task/agent → not `dcli-opencode`',
    '',
    'Always pass both budgets. Never auto-apply. Independently verify findings.',
    'The outer shell or agent tool also needs a finite timeout longer than the',
    'hard budget; use submit plus bounded wait when it cannot set one.',
    'Never retry quota, auth, permission, or timeout failures.',
    'Use exact wrapper lineage with explicit resume kinds.',
    '',
    'Backend selection:',
    '- For a cross-backend job, choose the explicitly requested different backend and load its skill.',
    '',
  ].join('\n'), 'utf8');

  // Worker prompts
  ensureDir(path.join(dir, 'worker-prompts'));
  for (const [role, body] of Object.entries(workerPromptBodies())) {
    fs.writeFileSync(path.join(dir, 'worker-prompts', `${role}.md`), body, 'utf8');
  }
}

// Rules common to every role. Each line here was earned by a real failure in
// the predecessor tool: a worker that asked the caller a question stalled an
// unattended job; a worker that wrote outside its artifact directory dirtied
// the user's tree; a worker that narrated progress led the caller to treat a
// phase signal as completion.
const WORKER_PREAMBLE = [
  'You are a dcli worker. A wrapper invoked you on behalf of an engineer who is',
  'not watching this session.',
  '',
  '- Answer the assigned task directly. Your final message IS the result the',
  '  wrapper returns — not a status report about it.',
  '- Do not ask follow-up questions unless the task is genuinely impossible',
  '  without one. Nobody is present to answer; the job will simply stall.',
  '- Do not modify files unless the access mode below explicitly allows it.',
  '- Work within the execution budget you were given. If you run out of room,',
  '  say what you covered and what you did not, rather than implying coverage',
  '  you did not achieve.',
  '- Never invoke a child command with an unbounded wait. Use the command\'s',
  '  finite timeout option when available; if a tool or test hangs, stop it',
  '  and report the bounded partial result instead of waiting indefinitely.',
  '- Do not recursively invoke the dcli shim for a subagent from your own',
  '  backend. If native subagents are needed, use the backend-native mechanism;',
  '  use dcli only for an intentional cross-backend boundary.',
  '',
  'Mode: {{MODE}}',
  'Access: {{ACCESS}}',
  'Repository: {{REPO_ROOT}}',
  'Artifact directory: {{ARTIFACT_DIR}}',
  '',
];

function workerPromptBodies() {
  // The reviewer's machine contract is generated from the same function the
  // runtime review prompt uses, which is in turn derived from the parser's
  // constants. One definition, three consumers — the appendix format cannot
  // drift between the docs, the live prompt, and core/findings.js.
  const { buildFindingsContract } = require('../core/commands/review');

  return {
    reviewer: [
      '# dcli worker prompt — reviewer',
      '',
      ...WORKER_PREAMBLE,
      'Judge the change on its own merits. Any stated intent or focus is context',
      'for scope and expected behavior — it is not evidence that the code is',
      'correct. Verify independently and report problems even when the intent',
      'implies the change is already fine.',
      '',
      'Lead with your findings, ordered by severity. Then append the machine-',
      'readable block described below.',
      '',
      'If your coverage was reduced for any reason — a truncated diff, files you',
      'could not read, budget exhaustion — say so explicitly. A review that',
      'silently covered only part of a change is worse than no review.',
      '',
      buildFindingsContract(),
    ].join('\n'),

    implementer: [
      '# dcli worker prompt — implementer',
      '',
      ...WORKER_PREAMBLE,
      'Implement the requested change with focused commits or plain edits. The',
      'wrapper snapshots your work afterwards; you do not need to publish,',
      'push, or open anything.',
      '',
      'Confine screenshots, traces, caches, and logs to the artifact directory',
      'above. Do not leave scratch files in the repository.',
      '',
      'Report what you changed and why, plus anything you deliberately left',
      'alone. If you could not complete the change, say so plainly — the',
      'engineer inspects your diff before applying it, and a claim of',
      'completeness that does not hold wastes that review.',
      '',
    ].join('\n'),

    brainstormer: [
      '# dcli worker prompt — brainstormer',
      '',
      ...WORKER_PREAMBLE,
      'Lay out the viable options, the trade-offs that actually distinguish',
      'them, and end with a single recommendation.',
      '',
      'Give a recommendation rather than an exhaustive survey. If you are',
      'genuinely torn, say what evidence would settle it.',
      '',
    ].join('\n'),
  };
}

function generate() {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  generateTo(GENERATED_DIR);
}

// Every markdown file the tool generates or reads as an agent-facing source.
function allDocs() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) out.push({ file: p, rel: path.relative(path.resolve(__dirname, '..'), p) });
    }
  };
  walk(GENERATED_DIR);
  walk(SOURCE_DIR);
  return out;
}

function check() {
  const os = require('os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcli-gen-check-'));
  let stale = false;

  try {
    const generatedHashes = {};
    const expectedHashes = {};

    // Generate into temp dir
    generateTo(tmpDir);

    // Collect hashes from both trees
    collectHashes(tmpDir, generatedHashes);
    collectHashes(GENERATED_DIR, expectedHashes);

    const allFiles = new Set([...Object.keys(generatedHashes), ...Object.keys(expectedHashes)]);

    for (const file of allFiles) {
      const inGen = file in generatedHashes;
      const inExpected = file in expectedHashes;

      if (inGen && !inExpected) {
        console.error(`STALE: ${file} is present in generated output but missing from integration/generated/`);
        stale = true;
      } else if (!inGen && inExpected) {
        console.error(`STALE: ${file} is present in integration/generated/ but missing from generated output`);
        stale = true;
      } else if (generatedHashes[file] !== expectedHashes[file]) {
        console.error(`STALE: ${file} content differs between generated output and integration/generated/`);
        stale = true;
      }
    }

    // Cross-template consistency checks (these check semantic correctness,
    // not just file-level parity — they catch content drift within generated
    // files that happen to have matching hashes from stale templates).
    for (const backend of BACKENDS) {
      const content = expectedHashes[`skills/dcli-${backend}/SKILL.md`]
        ? fs.readFileSync(path.join(GENERATED_DIR, 'skills', `dcli-${backend}`, 'SKILL.md'), 'utf8')
        : '';
      if (content && !content.includes('--hard-timeout-sec')) {
        console.error(`STALE: skills/dcli-${backend}/SKILL.md missing budget reference`);
        stale = true;
      }
      if (content && !content.includes(`dcli-${backend}`)) {
        console.error(`STALE: skills/dcli-${backend}/SKILL.md missing backend reference`);
        stale = true;
      }
    }

    // Every documented recipe carries a wait budget
    for (const { file, rel } of allDocs()) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const other of BACKENDS) {
          if (rel.includes(other)) continue;
          if (new RegExp(`(^|[\\s\`|$(])dcli-${other}\\s+[a-z]`).test(line)) {
            console.error(`STALE: ${rel}:${i + 1} invokes dcli-${other} in another backend's docs`);
            stale = true;
          }
        }
        if (!/\bdcli(-\w+)?\s+wait\b/.test(line)) return;
        if (!line.includes('--timeout-sec')) {
          console.error(`STALE: ${rel}:${i + 1} documents \`wait\` with no wait budget`);
          stale = true;
        } else if (/\[\s*--timeout-sec/.test(line)) {
          console.error(`STALE: ${rel}:${i + 1} shows the wait budget as optional`);
          stale = true;
        }
      });
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
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
