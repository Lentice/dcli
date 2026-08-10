// @suite full
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { check, regenerate, diffReport } = require('../../scripts/generate-tickets-table');

const README = path.resolve(__dirname, '../../docs/tickets/README.md');
const TICKETS_DIR = path.resolve(__dirname, '../../docs/tickets');

// Verify the checked-in tracker table still matches the ticket files before
// asserting semantics against it. This is a regenerate-and-compare gate, not a
// presence grep: it regenerates the whole table and compares byte-for-byte, so
// a status change in a ticket file that was not regenerated fails here.
check();

// ---------------------------------------------------------------------------
// 1. The generator is idempotent on the checked-in README.
// ---------------------------------------------------------------------------
{
  const before = fs.readFileSync(README, 'utf8');
  const after = regenerate(before);
  assert.strictEqual(after, before, 'regenerate() must be a no-op on an up-to-date README');
}

// ---------------------------------------------------------------------------
// 2. Prose outside the table markers is untouched by the generator.
//
// The paragraphs explaining why closed tickets stay listed, and the status
// vocabulary table, are hand-written and load-bearing. The generator rewrites
// only the table region between the explicit markers; an edit to surrounding
// prose must survive a regeneration byte-for-byte.
// ---------------------------------------------------------------------------
{
  const readme = fs.readFileSync(README, 'utf8');
  const marked = readme.replace(
    'A closed ticket is not necessarily an implemented one.',
    'PROSE-OUTSIDE-MARKERS-SURVIVES'
  );
  const out = regenerate(marked);
  assert.ok(
    out.includes('PROSE-OUTSIDE-MARKERS-SURVIVES'),
    'hand-written prose outside the markers must survive regeneration'
  );
  assert.ok(
    out.includes('Misleading `ETIMEDOUT`-as-crash diagnostics'),
    'scope cells are preserved verbatim'
  );
  assert.ok(
    out.includes('| `ready` | Blockers are done; can be handed to an implementer |'),
    'the hand-written status vocabulary table must survive'
  );

  // The table region still comes from the files, not from whatever the edited
  // prose said: regenerating the marked text must produce the same rows as
  // regenerating the pristine text.
  const strip = (s) => s.split('\n').filter((l) => l.includes('PROSE-OUTSIDE-MARKERS-SURVIVES')).join('\n');
  assert.ok(out.includes(strip(marked)), 'only the prose edit should differ, never the rows');
}

// ---------------------------------------------------------------------------
// 3. The gate is a regenerate-and-compare, and names the drifted ticket.
//
// A hand-edit to a row's status cell that disagrees with its ticket file must
// be reported by ticket id — not swallowed by a presence grep.
// ---------------------------------------------------------------------------
{
  const readme = fs.readFileSync(README, 'utf8');
  const handEdited = readme.replace(
    '| [98 — split `commands/index.js`](98-split-the-commands-index-grab-bag.md) | done |',
    '| [98 — split `commands/index.js`](98-split-the-commands-index-grab-bag.md) | ready |'
  );
  const report = diffReport(handEdited, regenerate(readme));
  assert.ok(
    report.some((l) => /ticket 98/.test(l)),
    `drift report must name ticket 98, got: ${JSON.stringify(report)}`
  );
}

// ---------------------------------------------------------------------------
// 4. Every ticket's rendered status agrees with its file's `**Status:**` field.
//
// Semantic sanity beyond the byte gate: for open tickets the rendered cell is
// the plain vocabulary value; for the frozen closed tickets 78-86 it is the
// bolded value with the file's date.
// ---------------------------------------------------------------------------
{
  const readme = fs.readFileSync(README, 'utf8');
  const rows = readme.split('\n').filter((l) => l.startsWith('| ['));

  const statusInFile = (id) => {
    const name = fs.readdirSync(TICKETS_DIR).find((f) => new RegExp(`^${id}-.*\\.md$`).test(f));
    assert.ok(name, `ticket file for ${id} must exist`);
    const content = fs.readFileSync(path.join(TICKETS_DIR, name), 'utf8');
    const m = content.match(/^\*\*Status:\*\*\s*([^\n]+)$/m);
    return m && m[1];
  };

  for (const id of ['92', '94', '96', '98', '100', '102', '103']) {
    const row = rows.find((l) => new RegExp(`\\]\\(${id}-`).test(l));
    assert.ok(row, `table must contain a row for ticket ${id}`);
    const fileStatus = statusInFile(id);
    assert.ok(fileStatus, `ticket ${id} must carry a status field`);
    const vocab = fileStatus.split(/\s+\(/)[0];
    if (id === '92' || id === '94' || id === '96' || id === '98') {
      assert.ok(row.includes(`| done |`), `row for ${id} must render "done": ${row}`);
    } else if (id === '103') {
      assert.ok(row.includes(`| blocked |`), `row for ${id} must render "blocked": ${row}`);
    } else {
      assert.ok(row.includes(`| ready |`), `row for ${id} must render "ready": ${row}`);
    }
    assert.ok(vocab && vocab.length > 0, `status field for ${id} must parse`);
  }
}

// ---------------------------------------------------------------------------
// 5. Frozen closed tickets 78-86 render their stored date; tickets with no
// status line keep their row's cell.
// ---------------------------------------------------------------------------
{
  const readme = fs.readFileSync(README, 'utf8');
  const row = (id) => readme.split('\n').find((l) => l.includes(`](${id}-`));
  assert.ok(row('81').includes('**done** (2026-08-04)'), '81 must render its frozen status+date');
  assert.ok(row('78').includes('**closed, not implemented** (2026-08-04)'), '78 must render frozen status+date');
  assert.ok(row('105').includes('**done** (2026-08-10)'), '105 must keep its no-field status cell');
}

console.log('All ticket-table generation tests passed.');
