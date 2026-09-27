---
recorded: 2026-08-22T20:28:33Z
incident_date: 2026-08-22
commit: 46a04ce1cb
---
# A sandbox environment carries one credential, not a boot protocol

**When:** provisioning a session or adding daemon boot data. Inject only the
session-bound `KORTIX_TOKEN`. The daemon must claim prompts and lifecycle
identifiers from the API with that token. Connector, provider, prompt, and
turn-ledger values must not enter the VM environment. *Incident:* an SampleCo
`env` dump exposed connector credentials and four Kortix aliases; a real
Platinum probe then found the initial-turn nonce still inherited by OpenCode.
*Enforcer:* runtime-env tests reject all boot payload keys, daemon wire tests
assert the authenticated claim, and the live guest probe must print only
`KORTIX_TOKEN` for credential-like names.
