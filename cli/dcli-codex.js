#!/usr/bin/env node
// dcli-codex shim — selects the codex backend before argument parsing
// so help text and validation are backend-specific from the first token.

process.argv.splice(2, 0, '--backend', 'codex');
require('./dcli');
