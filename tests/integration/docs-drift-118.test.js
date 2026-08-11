// @suite full
// Ticket 118 — the docs must not teach behavior the shipped code contradicts.
// Three subjects: §16 mode vocabulary, the claude recursion-guard paragraph, and
// §14 containment-record timing. Every assertion below failed on the pre-fix
// docs and locks the corrected contract so the drift cannot silently return.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const designSpec = fs.readFileSync(path.join(ROOT, 'docs', 'design-spec.md'), 'utf8');

// ---------------------------------------------------------------------------
// 1. §16: every `--mode <value>` the spec teaches must survive the real parser,
//    and the parser's accepted set is exactly run/implement.
// ---------------------------------------------------------------------------
{
  const { parseArgs } = require('../../core/cli-args');
  const MODES = ['run', 'implement'];
  const build = (v) => ['--backend', 'codex', 'run', '--mode', v, '--hard-timeout-sec', '60'];

  for (const v of MODES) {
    assert.doesNotThrow(() => parseArgs(build(v)), `parser must accept --mode ${v}`);
  }
  for (const bad of ['review', 'brainstorm', 'test']) {
    assert.throws(() => parseArgs(build(bad)), `parser must reject --mode ${bad} with exit 2`);
  }

  const re = /--mode\s+([A-Za-z][A-Za-z0-9_-]*)/g;
  let m;
  let checked = 0;
  while ((m = re.exec(designSpec)) !== null) {
    checked++;
    assert.ok(
      MODES.includes(m[1]),
      `docs/design-spec.md teaches "--mode ${m[1]}", which the parser rejects with exit 2`
    );
  }
  assert.ok(checked > 0, 'the spec must actually document --mode values for this gate to bite');
  console.log(`PASS: docs-drift 1 — ${checked} documented --mode values accepted by parseArgs`);
}

// ---------------------------------------------------------------------------
// 2. §16 records the shipped status.mode vocabulary and that review is not a mode.
// ---------------------------------------------------------------------------
{
  assert.ok(
    designSpec.includes('`--mode` accepts exactly `run` and `implement`'),
    '§16 must name the parser-accepted mode set run/implement'
  );
  assert.ok(
    /`run` is the default/.test(designSpec),
    '§16 must state that run is the default mode'
  );
  assert.ok(
    /`submit` for a run-mode submit/.test(designSpec),
    '§16 must record submit as the status.mode value of a run-mode submit'
  );
  assert.ok(
    /`review` is a subcommand, not a `--mode` value/.test(designSpec),
    '§16 must say review is a subcommand, not a mode'
  );
  console.log('PASS: docs-drift 2 — §16 mode vocabulary matches the shipped records');
}

// ---------------------------------------------------------------------------
// 3. §5 status.json example must not show an unshipped status.mode value.
// ---------------------------------------------------------------------------
{
  assert.ok(
    !/"mode": "review"/.test(designSpec),
    '§5 status.json example must not record "review" as a status.mode value'
  );
  console.log('PASS: docs-drift 3 — §5 example uses a shipped status.mode value');
}

// ---------------------------------------------------------------------------
// 4. cli-claude.md must not claim the recursion guard is unimplemented, and the
//    guard must be described as shipped (it is: cli/dcli-claude.js + the adapter).
// ---------------------------------------------------------------------------
{
  const refDir = path.join(ROOT, 'docs', 'reference');
  for (const file of fs.readdirSync(refDir)) {
    if (!file.endsWith('.md')) continue;
    const content = fs.readFileSync(path.join(refDir, file), 'utf8');
    assert.ok(
      !content.includes('implements this yet'),
      `${file} claims the claude recursion guard is not implemented`
    );
  }

  const claudeRef = fs.readFileSync(path.join(refDir, 'cli-claude.md'), 'utf8');
  assert.ok(
    /DCLI_WORKER/.test(claudeRef),
    'cli-claude.md must document the shipped DCLI_WORKER/DCLI_DEPTH guard'
  );
  console.log('PASS: docs-drift 4 — no unimplemented recursion-guard claim in docs/reference');
}

// ---------------------------------------------------------------------------
// 5. §14 amendment must tie the taskkill-tree record to a rung having run and
//    stay consistent with §5's absent-means-never-ran semantics.
// ---------------------------------------------------------------------------
{
  const start = designSpec.indexOf('Amendment 2026-08-11 — Windows tree termination');
  assert.ok(start !== -1, '§14 must contain the Windows tree-termination amendment');
  const amendment = designSpec.slice(start);

  assert.ok(
    /tree-kill rung has run/.test(amendment),
    '§14 must state the taskkill-tree record appears only after a tree-kill rung has run'
  );
  assert.ok(
    /containment: null/.test(amendment),
    '§14 must state a live Windows job carries containment: null until a tree-kill rung runs'
  );
  assert.ok(
    designSpec.includes('absent means no tree-kill rung ran'),
    '§5 must keep the absent-means-never-ran containment_survivors semantics'
  );
  console.log('PASS: docs-drift 5 — §14 record timing consistent with §5 semantics');
}

console.log('All docs-drift (ticket 118) tests passed.');
