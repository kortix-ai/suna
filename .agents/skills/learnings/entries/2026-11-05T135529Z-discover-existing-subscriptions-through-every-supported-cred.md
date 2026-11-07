---
recorded: 2026-11-05T13:55:29Z
incident_date: 2026-11-05
---
# Discover existing subscriptions through every supported credential store

**Rule:** When adding subscription usage or changing credential storage, discover every still-supported store. Reuse its access and refresh rules. Do not require users to reconnect, duplicate refresh tokens, or expose credentials in metadata.

**Trigger surface:** Models subscription discovery, usage refresh, and provider-account storage cutovers.

**Incident:** 2026-11-05: Models Usage read only account_secret_resources. Existing ChatGPT connections in project_secrets did not appear. The subscription list also excluded account-wide project-mode resources the runtime can use. Disconnecting and reconnecting created named resources and concealed the discovery gap. Review confirmed claude_subscription_logins was intentionally retired; advertising those rows as usable would create misleading cards. Usage polling must never rotate login tokens.

**Enforcement:** apps/api/src/__tests__/integration-subscription-discovery-http.test.ts covers supported legacy discovery, retired-source exclusion, project context, private resources, foreign projects, and disconnect cleanup. apps/api/src/llm-gateway/legacy-subscription-usage.test.ts covers authorized provider reads and prohibits token refresh during polling. packages/sdk/src/core/rest/projects-client/account-secret-resources.test.ts covers storage and project request identity.
