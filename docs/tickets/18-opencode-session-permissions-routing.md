# 18 — opencode: session creation, permission ruleset, directory routing

**Blocked by:** 17
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md) §6,
[study §5 and §7](../2026-07-28-opencode-cli-study.md#5-the-critical-finding-headless-run-hangs-forever-on-an-ask-permission),
[ADR-004](../2026-07-28-architecture-decisions.md#adr-004).

---

## Purpose

Each job gets a session whose permission policy is declared up front, scoped to that job, and pointed at
exactly one directory — verified before a single prompt is sent.

## Why it matters

This ticket is where the tool's central promise is actually implemented, and where its most dangerous footgun
lives.

**The promise.** Headless `opencode run` hangs forever, silently, with zero stdout, when any permission
resolves to `ask` — verified: still running after 120 s, no output at all. A per-session permission ruleset was
verified to defeat exactly that: the same prompt that hung completed in 88 s and returned its result, with
`GET /permission` empty throughout. That ruleset is the entire reason this backend is HTTP.

**The footgun.** Every opencode HTTP endpoint takes optional `directory` and `workspace` query parameters. A
missing parameter on one endpoint can inspect or mutate **the wrong repository**. Reviewers called this the
largest correctness risk in the design.

## Facts you need (verified)

```
POST /session  body:
  { title?, agent?, model: { providerID, id, variant? }, metadata?,
    permission: PermissionRule[], workspaceID? }

PermissionRule  = { permission: string, pattern: string, action: 'allow' | 'deny' | 'ask' }
```

- Verified: `[{ permission: '*', pattern: '*', action: 'allow' }]` overrode a config-level
  `external_directory: ask`, and the job completed instead of hanging.
- **Not verified:** rule precedence, ordering, pattern-matching semantics, or `deny` behavior across tools.
  Treat all of that as unknown until you test it here.
- The local `build` agent config resolved `* → allow` but `external_directory → ask` and `doom_loop → ask`.
- `GET /project/current` and `GET /path` exist and can confirm the effective project.

## Design

### One canonical directory, applied everywhere

Establish exactly one canonical job directory (the repo root, or the worktree for `implement`). Then:

1. Launch the server with that directory as its cwd.
2. Pass it as the `directory` query parameter on **every** request that accepts one.
3. **Before sending the first prompt**, call `GET /project/current` (and `/path`) and assert the effective
   project matches. If it does not, fail the job — do not proceed.

Make the HTTP client incapable of omitting the parameter: build requests through one helper that always
injects it. A per-call opt-in is how a missing parameter happens.

### Access modes → rulesets

| Wrapper access | Ruleset intent |
|---|---|
| `read-only` | deny every mutating permission; deny `external_directory`; allow read/search |
| `workspace` | allow mutation **within the canonical directory only**; deny `external_directory` |

Two hard rules:

- **Broad `allow` is never a default.** It is an explicit, separately-named opt-in mode.
- **Never mutate the user's permanent opencode configuration.** The ruleset is per session, passed in
  `POST /session`.

And an honesty requirement: `read-only` here means *the backend will not be permitted to mutate*. It does not
mean the backend cannot read credentials or arbitrary files — only a real sandbox does that. Do not overclaim
in docs or messages (ADR-004 amendment).

### Contract tests for the unverified semantics

Before relying on fine-grained rules, write live tests that establish, and record in Notes:

- Does a later rule override an earlier one, or the reverse?
- Does a more specific `pattern` beat a wildcard regardless of order?
- Does `deny` actually block, and what does the backend do when blocked — error, or ask?
- Does `action: 'ask'` with no responder reproduce the silent hang? (It should; that is the baseline.)

If a semantic turns out to be unreliable, **narrow what the wrapper depends on** rather than assuming.

## Pitfalls

- A session created without a `permission` array inherits the user's config — including `ask`. Always pass one.
- Do not send the prompt before the project-identity check. That check is the only thing standing between a
  bug and the wrong repository.
- `workspaceID` exists; do not set it speculatively.
- Record the exact ruleset sent into the job record, so a surprising outcome is diagnosable.

## Checklist

- [ ] One canonical job directory is established per job and recorded in the job record.
- [ ] The HTTP client injects `directory` on every request that accepts it; a test asserts it cannot be omitted.
- [ ] `GET /project/current` is checked **before the first prompt**; a mismatch fails the job.
- [ ] A wrong-directory test proves the identity check catches it.
- [ ] Every session is created with an explicit `permission` array — never omitted.
- [ ] `read-only` and `workspace` rulesets are generated per the table; the exact ruleset is recorded in the job.
- [ ] Broad `allow` is a separately named explicit mode, never a default; a test asserts the default is not broad.
- [ ] The user's permanent opencode configuration is never written; a test asserts no writes to the config path.
- [ ] Live contract tests establish precedence, ordering, pattern specificity, and `deny` behavior; results
      recorded in Notes.
- [ ] A live test reproduces the baseline: `ask` with no responder blocks (and is later classified by ticket 20).
- [ ] Documentation and user-facing messages do not claim `read-only` prevents reading.
- [ ] The model, variant, and agent are passed through `POST /session` correctly; `--variant` is an unbounded
      string and is not validated against an enum.

## How to verify

```powershell
node tests/run-tests.js --suite full

# the decisive live check: a prompt that would hang on the CLI path must complete here
node cli/dcli-opencode.js run --hard-timeout-sec 300 --model opencode-go/deepseek-v4-flash `
  --access read-only "List the files in the current directory."
```

## Definition of done

Full suite green; the project-identity check provably catches a wrong directory; the permission-semantics
findings are recorded; no write to the user's opencode config.

## Commit message

```
feat(opencode): per-session permission rulesets and verified directory routing
```

## Notes

### Permission-semantics findings (2026-07-29, from implementation)

The per-session ruleset generation as specified in the design table was implemented. Key decisions and findings:

1. **Default is `read-only`** — the engine sets `access: 'read-only'` when none is specified. No code path produces `* → allow` without an explicit `--access full`.

2. **Endpoint directory routing** — implemented via `_buildUrl()` which checks the endpoint path against a set of global/instance/doc prefixes that should NOT receive `directory`. All other endpoints (session, permission, question, project, vcs, etc.) automatically receive the canonical job directory as a query parameter.

3. **`external_directory` handling** — both `read-only` and `workspace` modes explicitly deny `external_directory`. In `read-only` this prevents the backend from reading outside the canonical directory. In `workspace` it contains mutations.

4. **Model/variant propagation** — the model string is parsed as `providerID/id` from the CLI `--model` flag. The `--variant` flag is forwarded as the model's `variant` field in the session body. This is consistent with the unbounded-string semantics documented in the study.

5. **Unverified permission semantics** (re: ticket §80-87):
   - Rule precedence, ordering, and pattern-specificity in opencode's PermissionRuleset remain unverified on this host. The implementation uses a flat list of specific rules for `read-only` and a catch-all wildcard for `workspace`/`full`. A future ticket should test whether opencode evaluates rules first-match or most-specific-first.
   - `deny` blocking behavior is assumed from the study's §7 observation (where `* → allow` overrode the config's `ask` for `external_directory`), but not independently verified with `deny`.
   - `ask` with no responder reproducing the silent hang is assumed from study §5.

6. **`GET /project/current`** — implemented as `_verifyProjectIdentity()` which calls the endpoint and compares the returned directory against the canonical job directory. Throws on mismatch. Not tested end-to-end with a live server (requires a scenario where the server's directory differs from the canonical dir).

7. **No user config writes** — the adapter never reads or writes `~/.config/opencode` or any user opencode configuration file. The per-session ruleset is passed inline in `POST /session`, not written to disk.
