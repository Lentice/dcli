# 13 — Secrets redaction and admission control

**Blocked by:** 03, 10
**Status:** ready-for-agent
**Read first:** [00-onboarding.md](00-onboarding.md), `AGENTS.md` "Smaller rules",
[design spec §19](../2026-07-28-design-spec.md#19-secrets-and-redaction).

---

## Purpose

No credential ever reaches disk, and a burst of jobs cannot exhaust the machine or the provider quota.

Both were gaps found in the architecture review — neither was in the original design.

## Why it matters

**Redaction.** The failure classifier is *designed* to read provider error bodies, because that is where the
discriminating information lives (a verified example: opencode reported credit exhaustion as HTTP 401 with
`responseBody.error.type = "CreditsError"`). Provider error bodies are also exactly where tokens live. So the
subsystem that most needs this data is the one most likely to persist a secret.

Once a token is on disk it has leaked — redacting on read is not a mitigation.

**Admission control.** Fan-out multiplies model runtimes, file watchers, caches, provider connections, and
memory — not merely process count. Ten small background tasks can become ten backend servers plus ten agent
processes and exhaust memory or provider quota *before* any timeout logic gets a chance to help.

## Design

### Redaction

Redact **before persistence**, in the writer path, not at the call sites — a call site will be forgotten.

Channels that must pass through redaction: environment snapshots, HTTP request/response bodies and headers,
`backend-events.jsonl`, `stdout.log`/`stderr.log`, `debug.json`, `command.json`/`command.txt`, and the
`doctor` envelope.

**Never written at all:** the per-job backend server password, provider credentials, `Authorization` headers,
credential-store contents.

Detection: a combination of known key names (case-insensitive `authorization`, `api[-_]?key`, `token`,
`secret`, `password`, `bearer`) plus registered runtime secrets — every secret the tool generates or reads
registers itself with the redactor at creation, so it is redacted by exact value regardless of where it
appears. The registered-value path is the one that actually works; pattern matching is the backstop.

Replacement is a stable placeholder (`«redacted:api_key»`) so diffs of redacted logs stay readable.

The state root is created with **owner-only ACLs**. Test it; do not trust the platform default.

A sanitizing export exists for sharing a job's artifacts.

### Admission control

An engine-level controller bounds **global** and **per-backend** concurrency, both configurable.

- Jobs beyond the limit **queue rather than launch**, and `status` reports them as queued (a distinct,
  documented condition — not a silent delay).
- Accounting is durable and **survives a controller crash**: a crashed controller must not permanently
  consume slots. Reconcile slot ownership by execution token and liveness, the same way job state is
  reconciled (ticket 04).
- Defaults are chosen from measurement, not guesswork. On the study host `opencode serve` was healthy in
  ~2 s against 30–90 s model turns, so startup cost is not the binding constraint at low concurrency —
  memory and provider quota are. Measure before setting a default and record the numbers.

## Pitfalls

- Do not redact at call sites. One forgotten site defeats the whole mechanism.
- Do not redact so aggressively that diagnostics become useless — that is why registered exact values matter.
- Prompts and results are **user content, not secrets**. Do not mangle them; offer the sanitizing export instead.
- A queued job is not a failed job. Do not time it out on its execution budget while it is still queued.
- Slot accounting that lives only in memory reintroduces the "identity lost on crash" bug class.

## Checklist

- [ ] Redaction happens in the writer path, before persistence — a test asserts a call site cannot bypass it.
- [ ] Every channel in the Design list is redacted.
- [ ] Nothing in the never-write list is ever written; a test asserts each.
- [ ] Runtime secrets register themselves with the redactor at creation and are redacted by exact value.
- [ ] Key-name pattern matching exists as a backstop.
- [ ] Replacement uses a stable placeholder.
- [ ] **Planted-token test:** inject a known secret into every input channel (env, HTTP body, HTTP header,
      backend event, stderr, command line) and grep the entire job directory — nothing found.
- [ ] The state root is created with owner-only ACLs; a test asserts the actual permissions.
- [ ] A sanitizing export exists and is tested.
- [ ] Admission control bounds global and per-backend concurrency, configurable.
- [ ] Jobs beyond the limit queue and `status` reports them as queued.
- [ ] A queued job's execution budget does not start until it launches.
- [ ] Slot accounting is durable and reconciled by execution token; a crashed-controller test proves slots are
      released.
- [ ] A fan-out test proves the limit holds and that queued jobs eventually run.
- [ ] Measured concurrency numbers are recorded in Notes and used to justify the defaults.

## How to verify

```powershell
node tests/run-tests.js --suite full

# planted-token check, by hand
node cli/delegate.js --backend fake run --hard-timeout-sec 60 "echo"
Select-String -Path "$env:LOCALAPPDATA\delegate-cli\jobs\*\*\**" -Pattern 'PLANTED_SECRET_VALUE' -ErrorAction SilentlyContinue
```

The `Select-String` must return nothing.

## Definition of done

The planted-token test finds nothing anywhere on disk, ACLs are asserted, and a fan-out test proves the
concurrency limit holds across a controller crash.

## Commit message

```
feat: write-path secret redaction and durable concurrency admission control
```

## Notes

Record the measured concurrency numbers here.
