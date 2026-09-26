---
recorded: 2026-09-10T18:54:33Z
incident_date: 2026-09-10
commit: fdf8ba3eba
---
# Custom diagnostic headers require explicit artifact redaction

**Incident.** Release run `34510198802` API shard 5 recorded
`x-kortix-ci-passthrough` in its public `results.json`. The request-capture
sensitive-header set did not mask it, and its hexadecimal value did not match
the final secret-shape scrubber. A bounded report inspection also printed
the captured header before this omission was identified.

**Rule.** Add every credential-bearing diagnostic header to capture-time
redaction when introducing it. Do not assume a final shape-based scrubber
recognizes arbitrary secrets. Inspect only selected response fields while
diagnosing a flow; do not print a whole request or result object.

**Enforcement.** `tests/src/core/client.ts` masks this header.
`tests/unit/client-ci-passthrough.test.ts` proves the outgoing request carries
the credential while the captured artifact omits its full value. The new
regression failed before the fix; all 32 focused client/scrubber tests pass.
Both release artifact guards also reject the exact diagnostic credential.
The staging Worker binding and matching GitHub Actions secret were rotated
at `2026-09-10T18:49:37Z`. The current Worker no longer reads that legacy
diagnostic binding; its HTTP health response remains `200` at source
`2dd55445`.
