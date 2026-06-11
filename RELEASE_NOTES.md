Connector actions fixed across apps

### Fixed
- **Named connector actions work again across apps** (Salesforce, Google Drive, Box, OneDrive, WhatsApp Business, and more). Tool calls were failing with an opaque "HTTP 502" because the connected account was attached under the wrong property name for many apps, so actions ran without their credentials. The binding is now resolved from each action's own definition — existing connectors work immediately, no reconnect needed.

### Improved
- When a connector call fails, the agent now sees the real cause — the upstream status and error message instead of a bare 502 — plus a pointer to the connector's raw `request` tool as a fallback. (Error responses moved from HTTP 502 to 500 so the message survives the proxy layer.)
- Connector call failures are now recorded with their reason, making them diagnosable in one step.
