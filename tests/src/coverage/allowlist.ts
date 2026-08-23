export interface AllowEntry {
  method: string;
  path: string;
  reason: string;
}

export const uncoveredAllow: AllowEntry[] = [
  {
    method: "POST",
    path: "/v1/admin/api/accounts/:*/members/:*/role",
    reason:
      "DEBT, not a considered exemption. The route has existed on the app for a while but was absent from tests/spec/routes.generated.json, so the gate never saw it; regenerating the manifest for the secret-grant route surfaced it. Nothing covers it — it needs a flow, and this entry exists so the gap stays visible instead of being re-hidden by a stale manifest.",
  },
  {
    method: "POST",
    path: "/v1/projects/provision-stream",
    reason:
      "SSE progress-stream sibling of the flow-covered POST /projects/provision (#6276 /new create page) — same provisioning engine and auth boundary; the JSON sibling carries the contract coverage, and its own source-level guards live in apps/api/src/projects/provision-stream.test.ts",
  },
  {
    method: "POST",
    path: "/v1/platform/boot-timeline",
    reason:
      "sandbox-only telemetry sink called by the in-guest boot relay with a sandbox token; not an end-user API route",
  },
  {
    method: "POST",
    path: "/v1/projects/:*/monitors/ingest",
    reason:
      "monitor-box-only event intake: the runner posts with its own box's sandbox token, authenticated against project_monitor_boxes; not an end-user API route. Auth, dedup, truncation, and rate-limit behavior are covered source-level in apps/api/src/__tests__/unit-monitor-ingest-route.test.ts",
  },
  {
    method: "PUT",
    path: "/v1/connectors/projects/:*/connectors/:*/sensitive",
    reason:
      "connector-scoped runtime endpoint — called by the in-sandbox connector with its own token, not by end-user clients; the user-facing equivalent is flow-covered",
  },
  {
    method: "DELETE",
    path: "/v1/projects/:*/channels/teams/installation",
    reason: "teams disconnect — manage-ACL teardown symmetric with the flow-covered connect",
  },
  {
    method: "GET",
    path: "/v1/projects/:*/channels/teams/manifest",
    reason: "teams sideload manifest — read-only generated artifact",
  },
  {
    method: "GET",
    path: "/v1/channels/teams/identity/login/:*",
    reason: "unauthenticated HTML redirect to the web teams-login page (identity link flow)",
  },
  {
    method: "POST",
    path: "/v1/channels/teams/identity/bind",
    reason: "authed identity bind, hit from the web teams-login page — mirrors the slack identity bind",
  },
  {
    method: "GET",
    path: "/v1/projects/:*/channels/teams/file",
    reason: "server-side file download proxy, exercised via the in-sandbox teams CLI, not end-user clients",
  },
  {
    method: "POST",
    path: "/v1/projects/:*/channels/teams/file/upload",
    reason: "server-side consent-card upload, exercised via the in-sandbox teams CLI, not end-user clients",
  },
  {
    method: "POST",
    path: "/v1/webhooks/teams/:*/messages",
    reason: "Bot Framework BYO-bot inbound webhook — JWT-authed by Microsoft, same shape as the flow-covered managed /v1/webhooks/teams/messages",
  },
  {
    method: "GET",
    path: "/v1/webhooks/teams/oauth/callback",
    reason: "Teams admin-consent OAuth callback — browser redirect from Microsoft (admin_consent+tenant), not an API client route; mirrors the slack oauth callback",
  },
];

export const externalRoutes: AllowEntry[] = [
  { method: "GET", path: "/v1/llm/models", reason: "llm-gateway standalone service (gateway-*.kortix.com), not in the main API manifest" },
  { method: "GET", path: "/v1/models", reason: "llm-gateway model-catalog alias" },
  { method: "GET", path: "/v1/openai/models", reason: "llm-gateway OpenAI-compat catalog alias" },
  { method: "POST", path: "/v1/chat/completions", reason: "llm-gateway chat completions" },
  { method: "POST", path: "/v1/llm/chat/completions", reason: "llm-gateway chat completions alias" },
  { method: "POST", path: "/v1/openai/chat/completions", reason: "llm-gateway OpenAI-compat chat alias" },
  { method: "POST", path: "/v1/messages", reason: "llm-gateway standalone service Anthropic-Messages ingress" },
  { method: "POST", path: "/v1/openai/messages", reason: "llm-gateway standalone service Anthropic-Messages ingress, OpenAI-compat-namespace alias" },
  { method: "GET", path: "/v1/setup/health", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "GET", path: "/v1/setup/install-status", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "GET", path: "/v1/setup/sandbox-providers", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "GET", path: "/v1/setup/setup-status", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "GET", path: "/v1/setup/setup-wizard-step", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "GET", path: "/v1/setup/status", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "POST", path: "/v1/setup/bootstrap-owner", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "POST", path: "/v1/setup/setup-complete", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
  { method: "POST", path: "/v1/setup/setup-wizard-step", reason: "self-hosted setup app is intentionally not mounted when internal billing is enabled" },
];
