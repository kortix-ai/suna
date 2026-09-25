---
recorded: 2026-08-21T22:56:49Z
incident_date: 2026-08-22
commit: 290ce2a73a
---
# Mint every OpenCode message id with the native sortable codec

**When:** delivering an initial, queued, retried, or imported OpenCode prompt.
Never compose `msg_` ids from base36 timestamps or UUIDs. OpenCode 1.17.11
uses id order to detect an answered prompt; an id that sorts after native
assistant ids repeats a completed initial prompt indefinitely.
*Incident:* Agency production webhooks created 40+ duplicate assistant answers
per session across DeepSeek and GLM. *Enforcer:* `sandbox-turn-lifecycle.test.ts`
requires `prepareInitialSandboxTurn()` to match `WIRE_MESSAGE_ID`.
