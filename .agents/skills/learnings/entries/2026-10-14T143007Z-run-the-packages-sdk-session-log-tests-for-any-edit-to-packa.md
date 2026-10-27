---
recorded: 2026-10-14T14:30:07Z
incident_date: 2026-10-14
---
# Run the packages/sdk session-log tests for any edit to packages/api-contract/src/session-log, comments included

**Rule:** An edit to `packages/api-contract/src/session-log/types.ts` makes the same edit in `packages/sdk/src/core/session-log/types.ts`, comments included, and runs `bun test src/core/session-log` in `packages/sdk` before the merge. The SDK keeps a byte-equal copy from `export const SESSION_LOG_SCHEMA` on.

**Trigger surface:** changing any file under `packages/api-contract/src/session-log/`, including a doc comment; reviewing such a change (run the SDK package tests, not only api-contract and kortixd).

**Incident:** 2026-10-14, P7.3 (#9855) changed a 2-line doc comment in the api-contract `types.ts`. The author and two review rounds ran the kortixd and api-contract suites, not the SDK suite. `types.test.ts` ("the SDK session-log types equal the api-contract copy") went red on `dev`; the P7.1 worker found it. Fixed forward in #9858 (`0a9da658d1`) within the hour. No deploy or user impact.

**Enforcement:** `packages/sdk/src/core/session-log/types.test.ts` (the drift test) in the `Tests` packages lane, which runs on every push to `dev`; it fails after the merge, not before, because a pull request into `dev` runs no CI.
