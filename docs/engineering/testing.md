# Testing and the gates

Read this before writing tests, and before believing a green suite.

## The gates

`npm run check` = `npm run lint` + the full suite. **Both green before any commit.** The quick suite is
for iterating; the full suite decides.

`eslint.config.js` is **deliberately narrow** and exists for one class of defect: syntactically valid
code that references a name which does not exist at runtime (`no-undef`). That class is invisible to
`node --check` and invisible to the suite whenever the path is mocked out, and it broke every codex job
once already.

- **Keep it green.** A permanently-red lint run is decoration, and nobody reads decoration. Adding a rule
  is a real decision: it must pass across the whole repo **in the same commit that enables it**.
- **Rules that are off say why, inline.** `no-fallthrough` and `no-unused-vars` are currently `'off'` with
  their violation counts and reasons recorded in the config. Do not silently drop a rule, and do not
  enable one red.
- Full `tsc --checkJs` is **not** used: it reports 20+ implicit-any errors in a single adapter file, and
  that signal-to-noise ratio guarantees nobody looks.

Tests are plain assertion scripts checked by exit code — no test-runner framework.

## The four layers

Run and reported independently, so one broken adapter does not mask the rest:

1. **Core tests** against a deterministic **fake adapter**. No real CLI. This is where lifecycle,
   locking, reconciliation, exit codes, and path normalization are proven.
2. **Adapter unit tests** over recorded fixtures: golden argv, recorded NDJSON/SSE/stream-json streams,
   recorded OpenAPI responses, and failure payloads.
3. **Contract tests** that *every* adapter must pass — the same suite run three times. This is what
   keeps the ADR-001 boundary honest.
4. **Opt-in live integration tests** pinned to tested backend versions.

```
core: pass
codex adapter: pass
opencode adapter: pass
claude adapter: pass
contract (codex/opencode/claude): pass
opencode live: skipped (not installed)
```

**Backend upgrades are a first-class event.** Each adapter owns its upgrade-check workflow and its own
golden fixtures; updating opencode must never rewrite the Codex or Claude fixtures.

## Fixture backends you need

A fake executable or fake HTTP server producing controlled behavior:

- Well-formed stream; malformed JSON lines; oversized single line; unknown event types.
- Exits 0 with no assistant text.
- **Hangs with zero output.** `opencode debug wait` is a ready-made indefinite-hang fixture.
- Emits a permission request and waits; emits a question and waits.
- Fills its stdout pipe before reading stdin (the backpressure deadlock).
- Spawns a grandchild that outlives it and holds a pipe open.
- Dies between spawn and startup sentinel.

## Fault injection, and the crash points it must cover

Kill the controller at each point and assert the job is recoverable or explicitly `interrupted` —
**never stuck `running`**, never orphaned, never holding a lock or worktree:

1. Immediately before process spawn.
2. Immediately after spawn, before durable identity is recorded.
3. During port discovery.
4. After the backend session exists but before it is recorded.
5. Mid-turn, with a pending interaction.
6. Before the snapshot commit.
7. After the snapshot commit, before terminal publication.
8. Between the cancel request and the hard kill.
9. During terminal publication itself.

## Must-have tests

- **Windows Job Object containment**: grandchildren die; wrapper death kills the tree; the degraded
  `taskkill` fallback is exercised and marks `containment.degraded`. Plus the Unix process-group
  equivalents.
- Worktree create / diff / apply / conflict / rollback, including verified restoration on exit `25`.
- Lock contention and PID-reuse simulation.
- Abrupt worker death → stale-job reconciliation → never permanently `running`.
- Findings-appendix validation, including the malformed-is-not-clean case.
- Failure-classification precedence, including the `401` + `CreditsError` case.
- Generation tests: no stale generated files; **no adapter's flag appears in another adapter's skill**;
  installed files byte-match the repo.
- Redaction: plant a token and grep the whole job directory for it.

## Rules learned the hard way

- **Test false greens are real and have shipped.** A whole commit was needed to fix tests that passed
  while asserting nothing. Prefer assertions on observable artifacts: exit code, byte-exact stdout, and
  on-disk job state.
- **A mocked-out path is an uncovered path, and no test count reveals it.** Every adapter's `Start()`
  opens with `if (this._testMode) { …; return }`. Because every adapter test set `_testMode`, the 80–110
  real lines below that guard were executed by *nothing* — which is how a `ReferenceError: child is not
  defined` shipped in the codex adapter and broke **every** codex job while 16 adapter tests stayed green.
  **Every branch a test-mode short-circuit skips needs at least one test that does not take the
  short-circuit.** See `tests/adapters/*/start-*-scope.test.js` for the shape. This generalizes beyond
  `_testMode`: any mock, stub, or injected override draws the same cliff.
- **Never assert only that something threw.** `assert.ok(err, 'must fail')` is satisfied by a crash in
  our own code — that bare assertion was the *sole* reason the codex temp-dir test passed, and it hid the
  bug above for two commits. Assert the failure's identity: `exitCode`, `code`, `failureClass`, or a
  message match, and explicitly reject `ReferenceError`/`TypeError`, which are programmer errors wearing
  the costume of the failure under test. Use `tests/helpers/assert-failure.js`.
- **Never leave a hang-shaped fixture process alive.** Terminate and *verify* fixture trees in a `finally`.
  A leaked fixture poisons every later test on the machine. Choose the fixture binary deliberately:
  `cmd.exe` given unrecognized switches becomes an *interactive shell that never exits*, which silently
  waited out opencode's entire 30 s startup sentinel. `process.execPath` with a bad script argument dies
  immediately, which is usually what a "backend died at startup" test actually wants.
- **Never assert a delta against shared global state.** The runner executes files concurrently, so a
  count of `dcli-*` entries in `os.tmpdir()` includes other tests' directories: two leak tests running
  together produced `Before: 17, after: 16`. Assert against the exact path or id the code under test
  created.
- **Synchronize on observed state, not sleeps.** Fixed `sleep` delays make suites slow and load-flaky; use
  ready/release markers.
- **A test's internal spawn bound is derived from the runner's budget, never hand-picked.** A
  `spawnSync`/`execSync` `timeout` smaller than the runner's per-file cap is a load-sensitive absolute
  number that fires under contention long before the runner would, and its `status: null` +
  `error.code === 'ETIMEDOUT'` is indistinguishable from a crash unless checked. Report the test's own
  budget expiring, never "the child crashed" — see `tests/helpers/spawn-assert.js`. A budget whose only
  job is to stop a hang is derived from the runner's budget (`DEFAULT_TIMEOUT`) or dropped so the runner's
  cap is the single bound (ticket 105).
- Fault injection comes **before** broad feature tests. Kill the controller at each defined crash point
  and assert the job is terminal or `interrupted` — never stuck `running`, never orphaned.
- The quick suite must **name** what it skipped. A silently shrinking suite is how coverage rots.

On Windows, real-time antivirus scanning can make each process creation unusually expensive. A local
exclusion for this repository and the test temp area may improve development speed, but the suite must
remain correct without one. Do not weaken concurrency, budgets, or assertions to compensate.

## Dogfooding

After each phase, run a scoped second-opinion review of that phase's diff. On the predecessor this
repeatedly found real defects internal review missed — including the installer bug in
[`lessons.md`](lessons.md) §9. Triage every finding explicitly: adopt with action, or reject with a
stated reason. Never present a delegated review's raw output as your own conclusion.
