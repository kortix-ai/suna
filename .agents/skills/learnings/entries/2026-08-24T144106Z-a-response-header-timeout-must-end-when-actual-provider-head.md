---
recorded: 2026-08-24T14:41:06Z
incident_date: 2026-08-24
commit: b250949eb1
---
# A response-header timeout must end when actual provider headers arrive

**When:** wrapping an AI SDK streaming request with a response-header deadline.
Apply the deadline to the provider `fetch`, then clear it when `fetch` resolves.
Do not use that deadline as the full-stream abort signal; AI SDK returns
synthetic gateway headers before Bedrock `/converse-stream` returns. Keep client
cancellation attached for the full body. *Incident:* SampleCo Fable produced 14
zero-token turns at 89-91 seconds, recorded as `200 ok=true`. *Enforcer:* gateway
header/body/cancellation and timeout-classification tests.
