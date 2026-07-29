# 27 — claude recursion guards, doctor, capabilities

**Blocked by:** 26
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md),
[ADR-005](../2026-07-28-architecture-decisions.md#adr-005),
[ADR-001 kill criterion R6](../2026-07-28-architecture-decisions.md#kill-criteria--when-to-abandon-adr-001-and-split-into-three-projects).

---

## Purpose

A Claude Code worker cannot recursively delegate back into `dcli-claude`, and the failure is fast and loud rather than
a fork bomb.

## Why it matters

`dcli-claude` is Claude Code wrapping Claude Code. The caller is a Claude session with the `dcli-claude` skill installed;
the worker is a Claude session that, unguarded, can discover the same skill and delegate again. Each level
multiplies processes, tokens, and cost.

This is also a formal **kill criterion** for the whole project (R6): if recursion cannot be reliably bounded — if
workers keep rediscovering `dcli-claude`, cannot run isolated, or leave native children outside containment — then
`dcli-claude` should be isolated or abandoned rather than weakening all three backends. Part of this ticket's job is
to establish, with evidence, that it *can* be bounded.

## Design

### Defense in depth — all four layers, not one

1. **Environment sentinel.** Stamp `DCLI_WORKER=1` (plus `DCLI_DEPTH=<n>`) into the child environment. On
   startup, `dcli-claude` reads them: if the sentinel is present and depth is at or above the configured limit,
   **fail fast with exit `2`** and a message explaining the guard.
2. **Capability removal.** Base worker runs on `--safe-mode` (or `--bare` per ticket 26's auth finding) plus
   `--disable-slash-commands`, so the worker has no skills to rediscover. Do not install the delegating skill
   into the worker context where that is avoidable.
3. **Instruction.** The generated skill and delegation rule (ticket 24) state that a `dcli-claude` worker must not
   delegate via `dcli-claude` unless explicitly requested and depth-bounded.
4. **Lineage record.** Store the parent wrapper job id and the native Claude session id **separately**, so a chain
   is auditable after the fact and a cycle is detectable.

Layer 1 is the enforcement; layers 2–4 make it unlikely to be reached.

### Depth limit

Default depth limit **1** — a worker may not delegate at all by default. Raising it is explicit, per invocation,
and recorded in the job. A request that would exceed the limit is exit `2` with `unsupported_capability`-style
detail naming the guard and the current depth.

### Cycle detection

Beyond depth: if a new job's `root_job_id` chain already contains a `dcli-claude` job for the same repository and
prompt fingerprint, refuse. Depth alone does not catch a two-node cycle created through a different entry point.

### Native children

Claude Code can spawn subagents and, with `--bg`, native background agents (bypassed per ADR-005). Verify that
**every** descendant a worker creates is inside the contained job. A native child that escapes containment is the
R6 failure condition — if it does escape, record it and escalate rather than shipping.

### Capabilities and doctor

- Declare `recursion_guard` as a supported capability with its depth limit, so a caller can inspect it.
- Doctor probe: confirm the sentinel round-trips (spawn a trivial worker, assert it sees the sentinel) and that
  the depth limit is enforced.

## Where this actually wires in — there is no existing scaffolding for it

This is genuinely new: `DCLI_WORKER`/`DCLI_DEPTH` do not exist anywhere in the codebase yet (checked
across `core/`, `adapters/`, `cli/`), and there is no precedent adapter to mirror the way ticket 25
was a precedent for ticket 26. Two distinct places need code, and it's easy to conflate them:

1. **The stamping side** — when `dcli-claude`'s adapter spawns the `claude` child process (the
   `Start()` method on `ClaudeAdapter` from ticket 26, analogous to `adapters/codex/adapter.js:309`),
   it must build that child's `env` with `DCLI_WORKER=1` and `DCLI_DEPTH=<parentDepth + 1>` merged
   into `process.env` (default parent depth is 0 when `DCLI_WORKER` is absent from the current
   process). `core/child-process.js` and `core/containment.js` already accept an `env` option on
   spawn (`core/child-process.js:106`, `core/containment.js:172`) — pass the sentinel through that
   existing option, don't add a second env-injection path.
2. **The reading side** — `cli/dcli-claude.js`'s entrypoint (which ticket 26 also has to create; see
   its ticket for the "mirror `cli/dcli-codex.js`" pointer) reads `process.env.DCLI_WORKER`/
   `DCLI_DEPTH` from **its own** process environment, before doing any other work, and exits `2` if
   depth is at or above the limit. This is a *different process* from the one that stamped the
   env — the chain is: outer `dcli-claude` → spawns `claude` child with the sentinel in its env →
   if that `claude` session shells out to `dcli-claude` again, the OS inherits the sentinel into
   that nested `dcli-claude` process automatically. Don't try to pass the depth as a CLI argument or
   IPC message; env inheritance is what makes it survive a rediscovered-skill invocation the wrapper
   didn't orchestrate.

Because ticket 27 is blocked by 26, sequence the work so the `Start()` env-building code and the
entrypoint depth-check land together — a recursion guard that only does one half is worse than
useless, since it looks tested but isn't.

## Pitfalls

- Do not rely on instruction alone. A model reading "don't do this" is not a guard.
- Do not rely on the sentinel alone either — an environment variable can be lost across a shim layer. That is why
  layers 2–4 exist.
- Do not silently clamp a too-deep request to the limit. Fail loudly; silent clamping hides a runaway.
- Do not let the guard block the *legitimate* case (an operator explicitly asking for one nested level).

## Checklist

- [ ] `DCLI_WORKER=1` and `DCLI_DEPTH=<n>` are stamped into every worker environment.
- [ ] `dcli-claude` reads both at startup and **fails fast with exit `2`** when the depth limit is reached.
- [ ] A round-trip test proves the sentinel survives every shim layer on Windows and Unix.
- [ ] Default depth limit is 1; raising it is explicit, per invocation, and recorded in the job.
- [ ] A too-deep request fails loudly and is **never silently clamped** — test.
- [ ] Worker runs disable skills (`--safe-mode`/`--bare` plus `--disable-slash-commands`).
- [ ] A live test proves a worker cannot invoke the delegating skill.
- [ ] Cycle detection refuses a repeated `dcli-claude` job for the same repo and prompt fingerprint in one lineage
      chain — test with a two-node cycle.
- [ ] Parent wrapper job id and native Claude session id are stored **separately**.
- [ ] A containment test proves every worker descendant, including subagents, is inside the contained job.
- [ ] If any native child escapes containment, it is recorded in Notes and escalated as an R6 finding rather than
      shipped.
- [ ] `recursion_guard` is declared in capabilities with its depth limit.
- [ ] Doctor probes the sentinel round-trip and the depth-limit enforcement.
- [ ] The legitimate explicit one-level-nested case still works — test.

## How to verify

```powershell
node tests/run-tests.js --suite full

# the sentinel must be visible to the worker
node cli/dcli-claude.js run --hard-timeout-sec 300 "Print the value of the DCLI_WORKER environment variable."

# and a nested attempt must fail fast
$env:DCLI_WORKER='1'; $env:DCLI_DEPTH='1'
node cli/dcli-claude.js run --hard-timeout-sec 60 "anything"   # expect exit 2
Remove-Item Env:DCLI_WORKER, Env:DCLI_DEPTH
```

## Definition of done

The nested attempt fails fast with exit `2`, the sentinel round-trips through every shim layer, cycle detection
catches a two-node cycle, and no worker descendant escapes containment.

## Commit message

```
feat(claude): depth-bounded recursion guards with cycle detection
```

## Notes

Record the containment finding for native children here — it is the R6 evidence.
