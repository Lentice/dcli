/**
 * Generate the docs/tickets/README.md tracker tables from the ticket files.
 *
 * Each ticket file carries its own `**Status:** <value>` / `**Blocked by:** <ids>`
 * pair (see TEMPLATE.md). This script renders the Open and Closed tables from
 * those files, rewriting only the table region between explicit markers; every
 * line of prose around and between the tables is hand-written and preserved.
 *
 * Usage:
 *   node scripts/generate-tickets-table.js              # generate
 *   node scripts/generate-tickets-table.js --check       # check for staleness (exit 1 if stale)
 */

const fs = require('fs');
const path = require('path');

const TICKETS_DIR = path.resolve(__dirname, '..', 'docs', 'tickets');
const README_FILE = path.join(TICKETS_DIR, 'README.md');

const OPEN_MARK = '<!-- GENERATED: open ticket table -->';
const CLOSED_MARK = '<!-- GENERATED: closed ticket table -->';
const END_MARK = '<!-- /GENERATED: ticket table -->';

const STATUS_VOCAB = ['ready', 'in progress', 'blocked', 'done', 'closed, not implemented', 'reference'];
const OPEN_STATUSES = new Set(['ready', 'in progress', 'blocked']);
// Frozen pre-rule status lines (tickets 78-86): `**Status:** done (2026-08-04)`.
const FROZEN_STATUS_RE = /^\*\*Status:\*\*\s*(done|closed)\s+(\d{4}-\d{2}-\d{2})\b/;
const FROZEN_VALUE = { done: 'done', closed: 'closed, not implemented' };
const NEW_STATUS_RE = /^\*\*Status:\*\*\s*([\w, ]+?)\s*$/;
// A blockers value is machine data only when it is `—`, `none`, or an id list.
const CLEAN_BLOCKED_RE = /^\*\*Blocked by:\*\*\s*(—|none|(?:\d+(?:\s*,\s*\d+)*))\s*$/;

const TICKET_FILE_RE = /^(\d+)-[^/]*\.md$/;
const ROW_RE = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/;
const TITLE_RE = /^#+\s+(.*)$/m;

/**
 * Parse one ticket file's machine data. Returns null for non-ticket files.
 * @param {string} filePath
 * @returns {{ id: string, file: string, title: string, status: object, blockedBy: object } | null}
 */
function parseTicketFile(filePath) {
  const base = path.basename(filePath);
  const idMatch = base.match(TICKET_FILE_RE);
  if (!idMatch) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  const titleMatch = content.match(TITLE_RE);
  const status = { has: false, value: null, date: null, format: null };
  const blockedBy = { has: false, cell: null };

  for (const line of content.split('\n')) {
    const fresh = line.match(NEW_STATUS_RE);
    if (fresh && STATUS_VOCAB.includes(fresh[1])) {
      status.has = true;
      status.value = fresh[1];
      status.format = 'new';
      continue;
    }
    const frozen = line.match(FROZEN_STATUS_RE);
    if (frozen) {
      status.has = true;
      status.value = FROZEN_VALUE[frozen[1]];
      status.date = frozen[2];
      status.format = 'frozen';
      continue;
    }
    const cleanBlocked = line.match(CLEAN_BLOCKED_RE);
    if (cleanBlocked) {
      blockedBy.has = true;
      blockedBy.cell = cleanBlocked[1] === '—' || cleanBlocked[1] === 'none'
        ? '—'
        : cleanBlocked[1].split(',').map((s) => s.trim()).join(', ');
    }
  }

  return {
    id: idMatch[1],
    file: base,
    title: titleMatch ? titleMatch[1].trim() : base,
    status,
    blockedBy,
  };
}

function loadTickets() {
  return fs.readdirSync(TICKETS_DIR)
    .filter((name) => TICKET_FILE_RE.test(name))
    .map((name) => parseTicketFile(path.join(TICKETS_DIR, name)));
}

/**
 * @returns {string|null} the rendered status cell, or null when the file cannot supply one.
 */
function renderStatusCell(status) {
  if (!status.has) return null;
  if (status.format === 'frozen') return `**${status.value}** (${status.date})`;
  return status.value;
}

/**
 * @returns {string|null} the rendered blockers cell, or null when the file cannot supply one.
 */
function renderBlockedByCell(blockedBy) {
  return blockedBy.has ? blockedBy.cell : null;
}

function defaultRow(ticket) {
  return { id: ticket.id, href: ticket.file, linkText: ticket.title, scope: '', statusCell: '', blockedByCell: '' };
}

function renderRow(row, ticket) {
  const statusCell = (ticket && renderStatusCell(ticket.status)) || row.statusCell;
  const blockedByCell = (ticket && renderBlockedByCell(ticket.blockedBy)) || row.blockedByCell;
  return `| [${row.linkText}](${row.href}) | ${statusCell} | ${blockedByCell} | ${row.scope} |`;
}

function renderTable(rows) {
  return ['| Ticket | Status | Blocked by | Scope |', '|---|---|---|---|', ...rows].join('\n') + '\n';
}

function parseRow(line) {
  const m = line.match(ROW_RE);
  if (!m) return null;
  const id = (m[2].match(/^(\d+)-/) || [])[1];
  return { id, href: m[2], linkText: m[1], statusCell: m[3], blockedByCell: m[4], scope: m[5], cell: line };
}

/**
 * Read the existing README rows so the generator can preserve their order,
 * link text and scope cells.
 * @param {string} text
 * @returns {{ openRows: object[], closedRows: object[] }}
 */
function parseExisting(text) {
  const openRows = [];
  const closedRows = [];
  let section = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## Open')) section = 'open';
    else if (line.startsWith('## Closed')) section = 'closed';
    else if (section && line.startsWith('| [')) {
      const row = parseRow(line);
      if (row) (section === 'open' ? openRows : closedRows).push(row);
    }
  }
  return { openRows, closedRows };
}

function buildTables(existing, tickets) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const existingById = new Map([...existing.openRows, ...existing.closedRows].map((r) => [r.id, r]));

  // A ticket's table is decided by its status field, or failing that by where
  // its row already sits (the closed tickets that carry no status line).
  const openIds = new Set();
  const closedIds = new Set();
  for (const t of tickets) {
    if (t.status.has) {
      if (OPEN_STATUSES.has(t.status.value)) openIds.add(t.id);
      else closedIds.add(t.id);
    } else if (existing.openRows.some((r) => r.id === t.id)) {
      openIds.add(t.id);
    } else {
      closedIds.add(t.id);
    }
  }

  const build = (existingRows, ids) => {
    const rows = [];
    const seen = new Set();
    for (const row of existingRows) {
      if (!ids.has(row.id)) continue;
      seen.add(row.id);
      rows.push(renderRow(row, byId.get(row.id)));
    }
    // A ticket with no row in this table yet (a new filing, or one that just
    // changed tables) reuses its row from the other table when there is one, so
    // the hand-written link text and scope survive the move.
    for (const id of ids) {
      if (seen.has(id)) continue;
      const ticket = byId.get(id);
      const base = existingById.get(id) || defaultRow(ticket);
      rows.push(renderRow(base, ticket));
    }
    return rows;
  };

  const openRows = build(existing.openRows, openIds);
  const closedRows = build(existing.closedRows, closedIds);
  return { openTable: renderTable(openRows), closedTable: renderTable(closedRows) };
}

function replaceRegion(text, startMarker, endMarker, replacement) {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`missing marker: ${startMarker}`);
  const contentStart = text.indexOf('\n', startIdx) + 1;
  const endIdx = text.indexOf(endMarker, contentStart);
  if (endIdx === -1) throw new Error(`missing end marker for: ${startMarker}`);
  return text.slice(0, contentStart) + replacement + text.slice(endIdx);
}

/**
 * Regenerate the table regions of a README text from the ticket files. Pure:
 * the surrounding prose and the marker lines themselves are preserved exactly.
 * @param {string} readmeText
 * @returns {string}
 */
function regenerate(readmeText) {
  const existing = parseExisting(readmeText);
  const tickets = loadTickets();
  const { openTable, closedTable } = buildTables(existing, tickets);
  const withOpen = replaceRegion(readmeText, OPEN_MARK, END_MARK, openTable);
  return replaceRegion(withOpen, CLOSED_MARK, END_MARK, closedTable);
}

function generate() {
  fs.writeFileSync(README_FILE, regenerate(fs.readFileSync(README_FILE, 'utf8')), 'utf8');
}

/**
 * Name every drifted row by ticket id.
 * @param {string} currentText
 * @param {string} expectedText
 * @returns {string[]}
 */
function diffReport(currentText, expectedText) {
  const cur = parseExisting(currentText);
  const exp = parseExisting(expectedText);
  const curMap = new Map([...cur.openRows, ...cur.closedRows].map((r) => [r.id, r]));
  const expMap = new Map([...exp.openRows, ...exp.closedRows].map((r) => [r.id, r]));
  const lines = [];
  for (const [id, row] of expMap) {
    if (!curMap.has(id)) lines.push(`STALE: missing table row for ticket ${id}`);
    else if (curMap.get(id).cell !== row.cell) lines.push(`STALE: table row for ticket ${id} differs from its file`);
  }
  for (const [id] of curMap) {
    if (!expMap.has(id)) lines.push(`STALE: table row for ticket ${id} has no matching ticket file`);
  }
  return lines;
}

function check() {
  const readme = fs.readFileSync(README_FILE, 'utf8');
  const expected = regenerate(readme);
  if (readme === expected) {
    console.log('Ticket table is up to date.');
    return;
  }
  for (const line of diffReport(readme, expected)) {
    console.error(line);
  }
  console.error('\nThe ticket table is stale. Run: node scripts/generate-tickets-table.js');
  process.exit(1);
}

// CLI
if (require.main === module) {
  if (process.argv.includes('--check')) {
    check();
  } else {
    generate();
    console.log('Generated the ticket table.');
  }
}

module.exports = { generate, check, regenerate, diffReport };
