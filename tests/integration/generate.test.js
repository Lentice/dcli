// @suite full
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { generate, check, BACKENDS, COMMANDS } = require('../../scripts/generate-integration');

const GENERATED_DIR = path.resolve(__dirname, '../../integration/generated');

// Verify the checked-in generated tree still matches the source generator before
// asserting semantics against it. This catches source changes that were not
// regenerated, rather than testing only whatever stale files happen to exist.
check();

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
  assert.ok(routerContent.includes('Native subagents'));
  assert.ok(routerContent.includes('cross-backend delegation'));

  const rulePath = path.join(GENERATED_DIR, 'rules', 'dcli-delegation.md');
  const ruleContent = fs.readFileSync(rulePath, 'utf8');
  const nativeSubagentPolicy = [
    { file: 'router skill', content: routerContent },
    ...BACKENDS.map((backend) => ({
      file: `dcli-${backend} skill`,
      content: fs.readFileSync(path.join(GENERATED_DIR, 'skills', `dcli-${backend}`, 'SKILL.md'), 'utf8'),
    })),
    { file: 'delegation rule', content: ruleContent },
  ];
  for (const content of nativeSubagentPolicy) {
    assert.match(content.content, /native subagent/i,
      `${content.file} must prefer native same-backend subagents`);
    assert.match(content.content, /dcli.*cross-backend|cross-backend.*dcli/i,
      `${content.file} must reserve dcli for cross-backend delegation`);
    for (const backend of BACKENDS) {
      const forbiddenRoute = 'not `dcli-' + backend + '`';
      assert.ok(content.content.includes(forbiddenRoute),
        `${content.file} must prohibit dcli-${backend} as a same-backend subagent substitute`);
    }
  }
  for (const backend of BACKENDS) {
    const skill = fs.readFileSync(
      path.join(GENERATED_DIR, 'skills', `dcli-${backend}`, 'SKILL.md'), 'utf8'
    );
    assert.doesNotMatch(skill, /\bdcli\s+--backend\b/,
      `dcli-${backend} skill must not teach the umbrella dcli as a subagent route`);
  }
  assert.match(ruleContent, /Use dcli only for intentional cross-backend delegation/,
    'shared rule must make cross-backend delegation the only dcli use case');
  assert.doesNotMatch(ruleContent, /dcli\s+--backend/,
    'shared rule must not teach the umbrella dcli as a same-backend subagent route');
  for (const line of ruleContent.split('\n')) {
    if (!/same-backend|own backend/i.test(line)) continue;
    assert.doesNotMatch(line, /\bdcli\b|shim/i,
      `same-backend guidance must not mention a dcli route: ${line}`);
  }
  for (const backend of BACKENDS) {
    const occurrences = ruleContent.split('dcli-' + backend).length - 1;
    assert.strictEqual(occurrences, 1,
      `shared rule must mention dcli-${backend} only in its same-backend prohibition`);
  }

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
// 2. Generated directory has expected structure
// ---------------------------------------------------------------------------
{
  // Verify structure without regenerating (avoids EBUSY on Windows)
  const skillsDir = path.join(GENERATED_DIR, 'skills');
  assert.ok(fs.existsSync(skillsDir));
  const entries = fs.readdirSync(skillsDir);
  assert.ok(entries.length >= 4, 'Must have at least 4 skill dirs (router + 3 backends), got ' + entries.length);
  const expected = ['dcli', 'dcli-claude', 'dcli-codex', 'dcli-opencode'];
  for (const e of expected) {
    assert.ok(entries.includes(e), 'Missing skill dir: ' + e);
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
        // The old form of this check exonerated a whole file whenever it
        // contained the substring "use " anywhere — true of essentially every
        // document, so a genuine leak could never fail it. Judge per line, and
        // only accept an exemption on the same line as the mention.
        const lines = content.split('\n');
        lines.forEach((line, i) => {
          const regex = new RegExp(`[\\s\`]${flag}[\\s\`]`, 'i');
          if (!regex.test(line)) return;
          const exempted = /not supported|instead of|use .* instead/i.test(line);
          assert.ok(
            exempted,
            `${owner}/SKILL.md:${i + 1} uses ${flag}, which is owned by ${otherOwner}: ${line.trim()}`
          );
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Every flag VALUE a doc teaches must survive the real argument parser.
//
// A recipe that exits 2 teaches every future agent a broken invocation, and
// nothing catches it today: the staleness checker only greps for the presence
// of `--hard-timeout-sec`. Validating against parseArgs itself — rather than a
// hand-copied list of legal values — means the docs cannot drift from the CLI.
// ---------------------------------------------------------------------------
{
  const { parseArgs } = require('../../core/commands/index');

  const docFiles = [];
  const collect = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(p);
      else if (entry.name.endsWith('.md')) docFiles.push(p);
    }
  };
  collect(GENERATED_DIR);
  collect(path.resolve(__dirname, '../../integration/source'));

  // Flags whose values are a closed set the parser validates, each paired with
  // an argv that actually reaches that validation. parseArgs only parses flags
  // once it has resolved a backend and a subcommand — omitting the `--backend`
  // prefix leaves command === null and every flag silently unexamined, which
  // makes a naive `parseArgs(['run', ...])` assert nothing at all.
  const VALUED_FLAGS = {
    '--mode': (v) => ['--backend', 'codex', 'run', '--mode', v, '--hard-timeout-sec', '60'],
    '--access': (v) => ['--backend', 'codex', 'run', '--access', v, '--hard-timeout-sec', '60'],
    '--kind': (v) => ['--backend', 'codex', 'resume', 'job-1', '--kind', v, '--hard-timeout-sec', '60'],
  };

  // Guard against this test going green because it reached no validation:
  // a known-bad value must be rejected through each builder.
  for (const [flag, build] of Object.entries(VALUED_FLAGS)) {
    assert.throws(
      () => parseArgs(build('definitely-not-a-legal-value')),
      `builder for ${flag} must reach the parser's validation`
    );
  }

  let checked = 0;
  for (const file of docFiles) {
    const content = fs.readFileSync(file, 'utf8');
    for (const [flag, build] of Object.entries(VALUED_FLAGS)) {
      const re = new RegExp(`\\${flag}\\s+([A-Za-z][A-Za-z0-9_-]*)`, 'g');
      let m;
      while ((m = re.exec(content)) !== null) {
        const value = m[1];
        checked++;
        let threw = null;
        try {
          parseArgs(build(value));
        } catch (err) {
          threw = err;
        }
        assert.strictEqual(
          threw, null,
          `${path.relative(process.cwd(), file)} teaches "${flag} ${value}", which the ` +
          `real parser rejects: ${threw && threw.message}`
        );
      }
    }
  }

  assert.ok(checked > 0, 'test must actually have found flag values to validate');
  console.log(`PASS: generate test 5 — ${checked} documented flag values accepted by parseArgs`);
}

// ---------------------------------------------------------------------------
// 6. A backend's own docs must never invoke a different backend's shim.
//
// AGENTS.md requires CI to fail on one adapter's flag leaking into another
// adapter's skill. A whole foreign shim command is the same defect, larger:
// it silently sends the reader to a different backend than the one whose
// documentation they are reading.
// ---------------------------------------------------------------------------
{
  const targets = [];
  for (const backend of BACKENDS) {
    targets.push({ backend, file: path.resolve(__dirname, `../../integration/source/${backend}.md`) });
    targets.push({ backend, file: path.join(GENERATED_DIR, 'skills', `dcli-${backend}`, 'SKILL.md') });
    for (const cmd of COMMANDS) {
      targets.push({ backend, file: path.join(GENERATED_DIR, 'commands', `dcli-${backend}`, `${cmd}.md`) });
    }
  }

  for (const { backend, file } of targets) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const other of BACKENDS) {
      if (other === backend) continue;
      lines.forEach((line, i) => {
        // An invocation, not prose mentioning the other backend by name.
        const re = new RegExp(`(^|[\\s\`|$(])dcli-${other}\\s+[a-z]`);
        assert.ok(
          !re.test(line),
          `${path.relative(process.cwd(), file)}:${i + 1} invokes dcli-${other} inside ` +
          `${backend} documentation: ${line.trim()}`
        );
      });
    }
  }
  console.log('PASS: generate test 6 — no cross-backend shim invocations');
}

// ---------------------------------------------------------------------------
// 7. Every documented `wait` carries a wait budget, non-optionally.
//
// This is the eight-hour incident in AGENTS.md. A recipe showing
// `[--timeout-sec <n>]` in optional brackets is precisely the defect: the
// reader is told the budget is discretionary, and an unbounded wait is what
// consumed a user's working session.
// ---------------------------------------------------------------------------
{
  const docFiles = [];
  const collect = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(p);
      else if (entry.name.endsWith('.md')) docFiles.push(p);
    }
  };
  collect(GENERATED_DIR);
  collect(path.resolve(__dirname, '../../integration/source'));

  let waitRecipes = 0;
  for (const file of docFiles) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\bdcli(-\w+)?\s+wait\b/.test(line)) return;
      waitRecipes++;
      const rel = `${path.relative(process.cwd(), file)}:${i + 1}`;
      assert.ok(
        line.includes('--timeout-sec'),
        `${rel} documents \`wait\` with no wait budget: ${line.trim()}`
      );
      assert.ok(
        !/\[\s*--timeout-sec/.test(line),
        `${rel} shows --timeout-sec as optional; a wait budget is mandatory in every ` +
        `documented recipe: ${line.trim()}`
      );
    });
  }

  assert.ok(waitRecipes > 0, 'test must actually have found wait recipes to check');
  console.log(`PASS: generate test 7 — ${waitRecipes} wait recipes all carry a mandatory budget`);
}

// ---------------------------------------------------------------------------
// 8. A recipe that gathers by group must have submitted into that group.
//
// `wait --all --group nightly` against a submit that never set --group matches
// nothing, so the recipe returns immediately having collected no results. That
// reads as "the work finished and there was nothing to report" — the same
// false-clean failure shape AGENTS.md calls out for parse failures.
// ---------------------------------------------------------------------------
{
  const docFiles = [];
  const collect = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(p);
      else if (entry.name.endsWith('.md')) docFiles.push(p);
    }
  };
  collect(GENERATED_DIR);
  collect(path.resolve(__dirname, '../../integration/source'));

  let blocksChecked = 0;
  for (const file of docFiles) {
    const content = fs.readFileSync(file, 'utf8');
    // Examine each fenced block as one self-contained recipe.
    const blocks = content.split(/^```/m).filter((_, i) => i % 2 === 1);
    for (const block of blocks) {
      const waitGroups = [...block.matchAll(/wait\s[^\n]*--group\s+([A-Za-z][\w-]*)/g)].map(m => m[1]);
      if (waitGroups.length === 0) continue;
      blocksChecked++;
      for (const group of waitGroups) {
        // A literal group name must be established by a submit in the same
        // recipe. Placeholders like <g> are documentation, not a concrete flow.
        if (/^<.*>$/.test(group)) continue;
        const submitLines = block.split('\n').filter(l => /\bsubmit\b/.test(l));
        if (submitLines.length === 0) continue;
        const establishes = submitLines.some(l => new RegExp(`--group\\s+${group}\\b`).test(l));
        assert.ok(
          establishes,
          `${path.relative(process.cwd(), file)}: recipe waits on --group ${group} but its ` +
          `submit never joins that group, so the wait matches nothing:\n${block.trim()}`
        );
      }
    }
  }

  assert.ok(blocksChecked > 0, 'test must actually have found group-gather recipes');
  console.log(`PASS: generate test 8 — ${blocksChecked} group-gather recipes are self-consistent`);
}

// ---------------------------------------------------------------------------
// 9. Worker prompts must carry real role-specific instruction, and the
// reviewer's must state the same findings contract the parser enforces.
//
// These files were three identical five-line stubs. A stub passes an
// existence check while teaching a worker nothing, which is the invisible
// doc rot AGENTS.md warns is the most expensive kind in this project.
// ---------------------------------------------------------------------------
{
  const { APPENDIX_MARKER, KNOWN_SEVERITIES } = require('../../core/findings');
  const dir = path.join(GENERATED_DIR, 'worker-prompts');
  const bodies = {};

  for (const role of ['reviewer', 'implementer', 'brainstormer']) {
    const file = path.join(dir, `${role}.md`);
    assert.ok(fs.existsSync(file), `worker prompt must exist: ${role}`);
    const content = fs.readFileSync(file, 'utf8');
    bodies[role] = content;

    for (const placeholder of ['{{MODE}}', '{{ACCESS}}', '{{REPO_ROOT}}', '{{ARTIFACT_DIR}}']) {
      assert.ok(
        content.includes(placeholder),
        `${role}.md must carry the ${placeholder} substitution — a worker that does not ` +
        `know its access mode cannot respect it`
      );
    }
    assert.ok(
      /do not ask follow-up questions/i.test(content),
      `${role}.md must tell the worker not to block on questions — nobody is watching an ` +
      `unattended job, so a question is a stall`
    );
  }

  // Roles must be genuinely different, not one template with the name swapped.
  const pairs = [['reviewer', 'implementer'], ['reviewer', 'brainstormer'], ['implementer', 'brainstormer']];
  for (const [a, b] of pairs) {
    const strip = (s) => s.split('\n').filter(l => !l.includes(a) && !l.includes(b)).join('\n');
    assert.notStrictEqual(
      strip(bodies[a]), strip(bodies[b]),
      `${a}.md and ${b}.md are the same template with the role name swapped`
    );
  }

  // The reviewer carries the full machine contract, derived from the parser.
  assert.ok(bodies.reviewer.includes(APPENDIX_MARKER), 'reviewer.md must state the exact marker');
  for (const severity of KNOWN_SEVERITIES) {
    assert.ok(
      bodies.reviewer.includes(severity),
      `reviewer.md must name the parser-recognized severity "${severity}"`
    );
  }
  assert.ok(/\bverdict\b/.test(bodies.reviewer), 'reviewer.md must name the verdict field');
  assert.ok(/empty/i.test(bodies.reviewer), 'reviewer.md must cover the clean-review form');
  assert.ok(
    /not evidence|on its own merits/i.test(bodies.reviewer),
    'reviewer.md must state that stated intent is context, not evidence of correctness'
  );

  // Only the reviewer emits findings; the others must not invite a stray marker.
  for (const role of ['implementer', 'brainstormer']) {
    assert.ok(
      !bodies[role].includes(APPENDIX_MARKER),
      `${role}.md must not mention the findings marker — a stray appendix from a non-review ` +
      `job is parsed as review output`
    );
  }
  console.log('PASS: generate test 9 — worker prompts are role-specific and contract-complete');
}

// ---------------------------------------------------------------------------
// 10. Any findings appendix a document shows as an example must actually parse.
//
// A worked example is the form a reader copies. core.md shipped one with the
// marker *inside* the ```json fence, which parseFindings rejects — so the
// canonical documentation taught the exact shape that produces
// findings_status: malformed.
// ---------------------------------------------------------------------------
{
  const { parseFindings, APPENDIX_MARKER } = require('../../core/findings');

  const docFiles = [];
  const collect = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(p);
      else if (entry.name.endsWith('.md')) docFiles.push(p);
    }
  };
  collect(GENERATED_DIR);
  collect(path.resolve(__dirname, '../../integration/source'));

  let examples = 0;
  for (const file of docFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(process.cwd(), file);

    // An example is a marker followed by a JSON object somewhere below it.
    // Only consider occurrences that actually carry a JSON body, so prose
    // references to the marker are not mistaken for worked examples.
    const idx = content.indexOf(APPENDIX_MARKER);
    if (idx === -1) continue;
    const after = content.slice(idx + APPENDIX_MARKER.length);
    if (!/^\s*(```json|\{)/.test(after)) continue;

    examples++;
    // Reconstruct the example as a worker would emit it and parse it for real.
    const jsonMatch = after.match(/\{[\s\S]*?\n\}/);
    assert.ok(jsonMatch, `${rel}: findings example has no JSON object body`);
    const candidate = APPENDIX_MARKER + '\n```json\n' + jsonMatch[0] + '\n```\n';
    const parsed = parseFindings(candidate);
    assert.strictEqual(
      parsed.status, 'ok',
      `${rel}: the documented findings example does not parse (${parsed.error}). ` +
      `Readers copy this shape verbatim.`
    );

    // And the marker must be shown outside the fence, as the parser requires.
    const fenceThenMarker = new RegExp('```json\\s*\\n\\s*' + APPENDIX_MARKER.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&'));
    assert.ok(
      !fenceThenMarker.test(content),
      `${rel}: shows the marker inside the \`\`\`json fence. The parser requires the marker ` +
      `on its own line BEFORE the fence; the documented form yields findings_status: malformed.`
    );
  }

  assert.ok(examples > 0, 'test must actually have found a documented findings example');
  console.log(`PASS: generate test 10 — ${examples} documented findings examples parse`);
}

// ---------------------------------------------------------------------------
// 11. No source filename may collide with an agent-instruction convention.
//
// integration/source/claude.md was indistinguishable from CLAUDE.md on this
// project's primary platform, where filenames are case-insensitive. Claude Code
// discovered it as directory-scoped project instructions, so the claude
// backend's reference data was injected as *directives* to any agent working in
// that tree. AGENTS.md is explicit that an agent reading one thing while
// running another is the failure mode that stays invisible.
// ---------------------------------------------------------------------------
{
  const RESERVED = ['claude.md', 'agents.md', 'readme.md', 'gemini.md', 'copilot-instructions.md'];
  const roots = [
    path.resolve(__dirname, '../../integration/source'),
    GENERATED_DIR,
  ];

  for (const root of roots) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(p); continue; }
        assert.ok(
          !RESERVED.includes(entry.name.toLowerCase()),
          `${path.relative(process.cwd(), p)} collides with the agent-instruction filename ` +
          `"${entry.name}" on a case-insensitive filesystem, so it is loaded as instructions ` +
          `rather than read as data. Rename it (backend-<name>.md).`
        );
      }
    };
    walk(root);
  }
  console.log('PASS: generate test 11 — no source filename collides with an instruction convention');
}

console.log('All integration generation tests passed.');
