---
recorded: 2026-09-10T18:54:33Z
incident_date: 2026-09-10
commit: fdf8ba3eba
---
# Browser and runtime tests must express the current user interaction

**Incident.** The v0.13.13 gate searched for a `Connected` heading behind an
open connector dialog. The current page exposes a `Connected` tab. Both
connector writes returned `200`, and the dialog showed `Reconnect`. The
RUN-9 fixture separately said "Disregard everything above"; the model
classified the latest user request as prompt injection and continued the
previous essay after a successful abort.

**Rule.** Close a modal before asserting on the page behind it. Match the
current accessible role. A transport cancellation fixture uses an ordinary
new user request, without asking the model to disregard prior instructions.
Keep the network, persisted-state, abort, and second-turn marker assertions.

**Enforcement.** `23-composio-connector.spec.ts` closes the detail dialog and
asserts the selected `Connected` tab. `session-thread-reliability.flow.ts`
uses an explicit essay cancellation followed by the same exact reply marker.
