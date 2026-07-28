I reviewed the diff and found one issue that should be addressed.

The change in `src/api/routes/users.js` introduces a potential race condition
when multiple requests hit the rate limiter simultaneously.

<!-- dcli:findings -->
```json
{
  "verdict": "Race condition in rate limiter, otherwise clean.",
  "items": [
    {
      "severity": "critical",
      "file": "src/api/routes/users.js",
      "line": 55,
      "claim": "Race condition in rate limiter check-then-act",
      "evidence": "The check at line 55 and the increment at line 58 are not atomic. Two concurrent requests can both pass the check before either increments, allowing double the intended rate.",
      "suggested_fix": "Use an atomic increment-and-check operation, or wrap in a mutex."
    }
  ]
}
```
