#!/usr/bin/env node
// dcli-claude shim — selects the claude backend before argument parsing
// so help text and validation are backend-specific from the first token.
// Also reads DCLI_WORKER/DCLI_DEPTH for recursion guard (ticket 27).

const DCLI_MAX_DEPTH = parseInt(process.env.DCLI_MAX_DEPTH || '1', 10);
const dcliWorker = process.env.DCLI_WORKER;
const dcliDepth = parseInt(process.env.DCLI_DEPTH || '0', 10);

if (dcliWorker === '1' && dcliDepth >= DCLI_MAX_DEPTH) {
  console.error(
    `dcli-claude recursion guard: depth limit (${DCLI_MAX_DEPTH}) reached. ` +
    `Current depth: ${dcliDepth}. ` +
    'A dcli-claude worker cannot delegate via dcli-claude by default. ' +
    'Set DCLI_MAX_DEPTH to a higher value to allow nested delegation.'
  );
  process.exit(2);
}

process.argv.splice(2, 0, '--backend', 'claude');
require('./dcli');
