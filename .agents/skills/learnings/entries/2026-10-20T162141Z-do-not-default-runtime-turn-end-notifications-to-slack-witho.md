---
recorded: 2026-10-20T16:21:41Z
incident_date: 2026-10-20
rule: Do not default runtime turn-end notifications to Slack without a channel recipient
---

# Do not default runtime turn-end notifications to Slack without a channel recipient

## Rule
Runtime turn ends apply to every session. Dispatch channel notifications only when a live turn or session metadata identifies a channel.

## Trigger surface
Changing channel relay routing or runtime turn-end delivery.

## Incident
KRTX-2339: non-channel errors fell through the historical Slack default and emitted a dropped-error warning without a Slack recipient. Preserve warnings for real Slack sessions, including late errors after finalization.

## Enforcement
`apps/api/src/channels/turn-relay.test.ts` covers non-channel and missing sessions, live Slack/Teams turns, metadata fallback, and legacy live rows without channel references.
