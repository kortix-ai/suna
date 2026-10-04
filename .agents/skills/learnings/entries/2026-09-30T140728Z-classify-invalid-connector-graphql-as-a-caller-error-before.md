---
recorded: 2026-09-30T14:07:28Z
incident_date: 2026-09-30
---
# Classify invalid connector GraphQL as a caller error before reporting an upstream failure

**Rule:** Classify Linear GraphQL validation and input refusals as caller errors. Keep the diagnostic in the tool result; do not retry as an upstream outage.

**Trigger surface:** Composio `linear.run_query_or_mutation` execution and gateway failure logging.

**Incident:** On 2026-09-29 and 2026-09-30, malformed agent-generated queries returned `GRAPHQL_VALIDATION_FAILED` and `INPUT_ERROR`. The API wrapped them as upstream 502 and emitted warnings despite a healthy provider (KRTX-678).

**Enforcement:** `bun test apps/api/src/services/connectors/composio.test.ts` checks that invalid GraphQL returns status 400 and keeps the diagnostic.
