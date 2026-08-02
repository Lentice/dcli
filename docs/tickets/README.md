# Active tickets

The implementation work is complete except for the two blockers below. Historical implementation tickets were
removed from this directory; the binding contracts live in the design spec, adapter contract, and tests.

| Ticket | Status | Scope |
|---|---|---|
| [00 — onboarding](00-onboarding.md) | reference | Repository rules and current job model |
| [78 — containment wiring](78-adapters-spawn-through-containment.md) | open | Route backend launches through the native containment helper |
| [81 — opencode unknown status](81-opencode-unknown-status-never-terminates.md) | open | Bound `unknown` status polling and preserve an honest terminal result |

Pick up 78 only after confirming the native helper protocol is sufficient; pick up 81 independently. Every
change must update the canonical docs and pass `npm run check` in an environment that permits the test suite's
temporary directories.
