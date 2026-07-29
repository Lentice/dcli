# 43 — OpenCode `submit` fails because `params.json` lacks `canonicalDir`

**Blocked by:** None — can start immediately
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` §"The five invariants" #2
(adapters emit facts), mistake #6 (validate before you convert/act — params shape is a contract).

---

## Purpose

`dcli-opencode submit` must produce a working background job. Today every opencode submit job
fails with `"Cannot send prompt: no canonical job directory set. Call PrepareInvocation first."`

## Why it matters

**OpenCode submit is completely broken.** Unlike codex and claude (whose `submit` background
workers run to completion), every opencode submit creates a job that immediately fails. The
background worker spawned by `submit` crashes before it can produce any useful work.

This is especially harmful because the opencode backend has the richest capabilities
(per-session permission rulesets, HTTP-driven interaction handling), and `submit` is the
primary async delegation path for long-running tasks.

## Evidence (verified live on this machine)

```
echo "Say hello" | node cli/dcli-opencode.js submit --repo . --hard-timeout-sec 60 --group test1 --json
# → {"state":"created", "job_id":"20260729T075436Z-s14ozlp4"}

# 3 seconds later:
node cli/dcli-opencode.js status 20260729T075436Z-s14ozlp4 --repo . --json
# → {"state":"failed", "failure":"Cannot send prompt: no canonical job directory set. Call PrepareInvocation first."}
```

Journal confirms the worker started and hit `SendPrompt` without `_canonicalDir`:
```
{"seq":1,...,"kind":"job_created"...}
{"seq":2,...,"kind":"attempt_created"...}
{"seq":3,...,"kind":"attempt_state_changed","to":"running"...}
{"seq":4,...,"kind":"heartbeat"...}
{"seq":5,...,"kind":"attempt_state_changed","to":"failed",
 "detail":{"failure_reason":"adapter_error",
           "failure":"Cannot send prompt: no canonical job directory set. Call PrepareInvocation first."}}
```

Root cause: `core/commands/submit.js` writes `params.json` to the job directory with this
shape:

```js
writeJsonFileAtomic(path.join(jobDir, 'params.json'), {
    model,
    access: inheritedAccess,
    reasoningEffort: reasoningEffort || null,
    variant: variant || null,
    effort: effort || null,
    mode: 'run',
    hardTimeoutMs: hardTimeoutSec && hardTimeoutSec > 0 ? hardTimeoutSec * 1000 : 0,
    _adapterScript: adapter.script || null,
});
```

The `opencode` adapter's `PrepareInvocation` (line 775 of `adapters/opencode/adapter.js`)
reads `request.canonicalDir` to set `this._canonicalDir`. Since `params.json` has no
`canonicalDir`, the field stays `undefined`. Later, `SendPrompt` (line 922) throws:

```js
throw new Error('Cannot send prompt: no canonical job directory set. Call PrepareInvocation first.');
```

By contrast, `core/commands/run.js` builds the `request` object from parsed CLI args and
includes `canonicalDir: repoRoot` — so `run` works fine.

The `codex` and `claude` adapters' `PrepareInvocation` do not require `canonicalDir`, so their
`submit` workers succeed.

## Design

`submit.js` must include `canonicalDir` in the `params.json` written to disk, so the
background worker can pass it to the adapter.

The canonical directory is `repoRoot` — the same value `run.js` passes. Since `executeSubmit`
already receives `repoRoot` from the caller (`cli/dcli.js` line 187:
`executeSubmit({..., repoRoot: fullPath, ...})`), it has the value available.

Change `submit.js` lines 81–90 to include `canonicalDir` in the params object:

```js
writeJsonFileAtomic(path.join(jobDir, 'params.json'), {
    canonicalDir: repoRoot,
    model,
    access: inheritedAccess,
    // ...rest unchanged
});
```

Alternatively (or additionally), the worker (`core/commands/worker.js`) could merge
`repoRoot` from the `DCLI_REPO_ROOT` environment variable into the params before calling
`PrepareInvocation` — but the simpler, self-documenting fix is to write it correctly in
`submit.js` so the params file is a complete description of the job.

## Pitfalls

- `repoRoot` on Windows may use forward slashes (normalized by `computeRepoKeyWithPath`).
  The opencode adapter already handles forward-slash paths — verify this doesn't introduce
  a quoting or path-separator issue.
- The codex and claude adapters' `PrepareInvocation` ignore `canonicalDir` — adding the field
  to params.json has no effect on those backends.
- This ticket only fixes the params.json content. The deeper issue (ticket 29 — submit
  worker lifecycle, identity persistence, containment) is a prerequisite for this fix to
  be meaningful.

## Checklist

- [ ] `submit.js` writes `canonicalDir: repoRoot` into `params.json`.
- [ ] `dcli-opencode submit` with a trivial prompt produces a job that reaches `done` (not `failed`).
- [ ] `dcli-codex submit` and `dcli-claude submit` still work (regression check).
- [ ] Full suite green.

## How to verify

```powershell
echo "Say hello in one word." | node cli/dcli-opencode.js submit --repo . --hard-timeout-sec 120 --group v --json
Start-Sleep -Seconds 15
node cli/dcli-opencode.js wait --repo . --group v --all --timeout-sec 60 --json
# Must show state:done, not state:failed
```

## Definition of done

`dcli-opencode submit` produces a job that reaches a terminal `done` state with a real
non-empty result, without manual intervention.

## Commit message

```
fix: write canonicalDir into submit params.json so opencode worker can prepare invocation
```
