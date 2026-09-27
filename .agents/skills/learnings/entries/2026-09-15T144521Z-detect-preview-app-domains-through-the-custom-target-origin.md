---
recorded: 2026-09-15T14:45:21Z
incident_date: 2026-09-15
commit: 82dd96e754
---
# Detect preview App domains through the custom target origin

**When:** asserting App URLs in a preview Playwright journey. `loadEnv()` classifies sandbox HTTPS origins as `custom`, not `preview`; derive the App-domain suffix from that origin. *Near-miss:* the v0.13.15 preview browser gate expected `custom-…apps.kortix.com` for a valid `preview-…apps.eu-west.sbx.platinum.dev` URL. *Enforcer:* the Apps browser journey passed against the retained preview origin with the custom-target assertion.
