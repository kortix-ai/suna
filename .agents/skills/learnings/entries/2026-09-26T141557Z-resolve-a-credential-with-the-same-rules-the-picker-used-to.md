---
recorded: 2026-09-26T14:15:57Z
incident_date: 2026-09-26
---
# Resolve a credential with the same rules the picker used to offer the model

**Rule:** The code that serves a request must reach every credential the code
that LISTED the model reached for the same principal. When a picker or catalog
offers a model because a shared credential exists, the resolver must be able to
use that credential for that principal. When the resolver has a precedence chain
(explicit selection > personal > legacy), check every principal class for a gap
between "listed" and "resolvable": unattended sessions (Slack, cron triggers,
agent-started workers) have no explicit selection and no personal owner, and a
member who did not create a shared resource has no personal copy of it.

**Trigger surface:** adding or changing a provider credential kind, a precedence
step in `resolveCandidates`, or the catalog/picker read
(`servableProjectCatalog`, `listUsableGatewaySecrets`).

**Incident:** A production project used GPT-6 through a ChatGPT (codex) account
shared with "Everyone in this project", with `pooled_provider_secrets` ON. Slack
runs, cron-trigger sessions, and agent-started workers failed their first turn
with `provider_not_connected` "Connect Codex to use this model.". Sessions
started by the member who created the account worked, so users read it as a
flaky connection. The picker listed the model through `listUsableGatewaySecrets`.
`resolveCandidates` reached shared accounts only through an explicit session
pool (`session_provider_secret_pools`, absent for those sessions) or through
`resolveDefaultCodexAccountSecret` (only the caller's own account), and then
fell through to the legacy project connection. Reproduced locally on the
pre-fix code: `400 provider_not_connected` for a member who did not create the
account. Fixed in branch `gateway-shared-codex-fallback`.

**Enforcement:** `apps/api/src/services/llm-gateway/resolution/resolve-candidates.test.ts`
("codex, unconfigured session, project-shared ChatGPT accounts", 14 cases, 8
red on the old code) and the real-PostgreSQL cases in
`apps/api/src/__tests__/integration-usable-gateway-secrets.test.ts`
(`resolveProjectSharedProviderSecrets`: agent principal, non-creator member,
restricted account not granted, outsider, cooldown). Enforced since 2026-09-29 by `apps/api/src/services/llm-gateway/servable-catalog-parity.test.ts`
(KRTX-431): for each principal class, every model `servableProjectCatalog`
lists runs in `resolveCandidates` — directly (the shared-account fallback) or
through the session-admission key selection (`usableProviderKeys`). The BYOK
analog is settled by design: session admission selects pooled keys at create /
model change / sharing change, and a resolver-level BYOK fallback was rejected
(#7779) because it let sessions main deliberately keeps off pooled keys reach
them at run time.
