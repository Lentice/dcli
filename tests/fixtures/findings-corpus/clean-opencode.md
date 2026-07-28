## Review: src/auth.js

The authentication module looks solid. The token refresh logic correctly handles
the edge case where both tokens expire simultaneously.

One concern in the error handling path:

<!-- dcli:findings -->
```json
{
  "verdict": "Minor improvements suggested for error handling and logging.",
  "items": [
    {
      "severity": "important",
      "file": "src/auth.js",
      "line": 142,
      "claim": "Error message leaks token presence information",
      "evidence": "Line 142 logs 'Token missing from header' which reveals token-based auth to an attacker who can read logs.",
      "suggested_fix": "Log a generic message like 'Authentication failed' instead."
    },
    {
      "severity": "minor",
      "file": "src/auth.js",
      "line": 88,
      "claim": "Unused import: crypto",
      "evidence": "The crypto module is imported at line 1 but never used in this file.",
      "suggested_fix": "Remove the import."
    }
  ]
}
```
