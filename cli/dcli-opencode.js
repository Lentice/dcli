#!/usr/bin/env node
// dcli-opencode shim — selects the opencode backend before argument parsing
// so help text and validation are backend-specific from the first token.

process.argv.splice(2, 0, '--backend', 'opencode');
require('./dcli');
