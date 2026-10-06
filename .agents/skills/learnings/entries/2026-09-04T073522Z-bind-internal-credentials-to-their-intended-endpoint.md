---
recorded: 2026-09-04T07:35:22Z
incident_date: 2026-09-04
commit: 77681271d3
---
# Bind internal credentials to their intended endpoint

**When:** adapting an internal session token for model-provider authentication.
**Incident:** the Pi worker treated `KORTIX_TOKEN` as an API key even without a gateway URL,
which could send the control-plane credential directly to an external provider.
**Rule:** use the session token for model calls only when the Kortix gateway URL is configured.
**Enforcer:** `model-credential-required.test.ts` covers direct, gateway, and missing-key paths.
