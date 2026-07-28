// @suite full
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

async function main() {

// ===========================================================================
// Core/ directory must contain no backend-specific conditional
// ===========================================================================
{
  const coreDir = path.resolve(__dirname, '..', '..', '..', 'core');
  const entries = fs.readdirSync(coreDir, { withFileTypes: true });

  const jsFiles = entries.filter(e => e.isFile() && e.name.endsWith('.js'));

  // Regex patterns that indicate backend-specific conditionals
  // We look for string literals matching backend identifiers in control flow
  const backendStrings = [
    /(?:['"`])codex(?:['"`])/i,
    /(?:['"`])opencode(?:['"`])/i,
    /(?:['"`])claude(?:['"`])/i,
  ];

  // Exceptions: files that are allowed to reference backend names
  const exceptions = new Set([
    'fact-types.js',       // defines the fact vocabulary (some backend names in comments/docs)
    'interaction-outcome.js', // shared enum
    'admission.js',        // admission controller references backends as slot keys
    'commands/index.js',   // CLI arg parsing references all backends
    'reducer.js',          // reducer works with facts and is backend-agnostic
  ]);

  for (const file of jsFiles) {
    if (exceptions.has(file.name)) continue;

    const content = fs.readFileSync(path.join(coreDir, file.name), 'utf8');

    // Skip lines that are comments or strings in require() calls
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Skip comments
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

      // Check for backend string literals used in conditional contexts
      for (const pattern of backendStrings) {
        if (pattern.test(trimmed)) {
          // Check it's actually in a conditional, not just a comment or require
          const condIndicators = ['if ', '===', '!==', 'switch', 'case ', '? '];
          if (condIndicators.some(ind => trimmed.includes(ind))) {
            assert.fail(
              `Backend-specific conditional found in core/${file.name}:${i + 1}: "${trimmed.trim()}"`
            );
          }
        }
      }
    }
  }

  console.log('PASS: No backend-specific conditional found in core/');
}

}

main().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
