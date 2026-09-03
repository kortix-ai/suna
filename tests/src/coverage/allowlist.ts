export interface AllowEntry {
  method: string;
  path: string;
  reason: string;
}

export const uncoveredAllow: AllowEntry[] = [
  {
    method: "PATCH",
    path: "/v1/auth/user",
    reason:
      "Headless profile-metadata write, the replacement for supabase.auth.updateUser({ data }). Covered at the unit level by apps/api/src/__tests__/unit-auth-user-metadata.test.ts (caller-bearer forwarding, .strict() refusal of a smuggled password/email, GoTrue error passthrough) and verified live against real GoTrue. No ke2e flow yet: the local test profile has no second confirmed user to attribute a metadata write to, and asserting it as the same user the flow already signs in as would test GoTrue, not us.",
  },
  {
    method: "POST",
    path: "/v1/auth/sign-in/sso",
    reason:
      "Enterprise SSO discovery. Cannot be flow-covered on the local profile: SAML is disabled there, so the route can only ever answer saml_provider_disabled — asserting that would pin the absence of a provider, not the behaviour. Unit-covered in unit-auth-headless.test.ts (redirect URL returned, 404 passthrough for a domain with no IdP). Needs a staging flow once an IdP exists.",
  },
  {
    method: "POST",
    path: "/v1/auth/mfa/factors",
    reason:
      "MFA enrol. Local Supabase ships MFA disabled (GOTRUE_MFA_TOTP_ENROLL_ENABLED=false), so the local profile cannot exercise it without changing Supabase config the profile does not own. Unit-covered in unit-auth-mfa.test.ts and verified end to end by hand against real GoTrue with TOTP enabled: enrol -> challenge -> verify with a generated code -> a token carrying aal2.",
  },
  {
    method: "POST",
    path: "/v1/auth/mfa/factors/:*/challenge",
    reason: "MFA challenge — same reason as POST /v1/auth/mfa/factors: MFA is disabled on the local test profile's Supabase.",
  },
  {
    method: "POST",
    path: "/v1/auth/mfa/factors/:*/verify",
    reason: "MFA verify — same reason as POST /v1/auth/mfa/factors. This is the leg that produces an aal2 session, which authorize() step 6 requires; verified by hand, not by the local profile.",
  },
  {
    method: "DELETE",
    path: "/v1/auth/mfa/factors/:*",
    reason: "MFA unenrol — same reason as POST /v1/auth/mfa/factors.",
  },
  {
    method: "GET",
    path: "/v1/projects/:*/git/connection",
    reason:
      "DEBT, not a considered exemption, and NOT introduced by this branch. The route exists on the app but was missing from tests/spec/routes.generated.json, so the gate never saw it; regenerating the manifest for the headless-auth routes surfaced it. Nothing covers it — it needs a flow. This entry keeps the gap visible instead of letting a stale manifest re-hide it.",
  },
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
    path: "/v1/platform/runtime-projection",
    reason:
      "sandbox-only projection sink: the in-guest daemon pushes its own /kortix/opencode/state document with a sandbox token, and the handler re-checks that token's sandbox against session_sandboxes (sandbox -> session -> account) before storing. Not an end-user API route — same class as /v1/platform/boot-timeline. Credential, scoping, gzip decoding and the decompressed size cap are covered black-box in apps/api/src/platform/routes/runtime-projection.test.ts; the SERVED side is flow-covered through the snapshot runtime leg in SESS-20.",
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
  {
    method: "POST",
    path: "/v1/projects/:*/sessions/:*/environment/ensure",
    reason:
      "DEBT. Harness/worker split P1.7: lazily provisions the pi session's compute environment — a REAL cloud sandbox, which the local flow profile explicitly excludes, so no local flow can exercise it yet. Auth ordering, the session-caller self-scope, and the pi-worker slug gate are pinned source-level in apps/api/src/projects/routes/session-environment.test.ts; the live contract is verified against dev. Needs a staging flow once the target-full profile grows a pi lane.",
  },
  {
    method: "GET",
    path: "/v1/projects/:*/sessions/:*/environment",
    reason:
      "DEBT. Read-only status sibling of environment/ensure (same auth gate, never provisions) — same cloud-sandbox exclusion keeps it out of local flows; pinned in the same source test.",
  },
  {
    method: "POST",
    path: "/v1/projects/:*/sessions/:*/environment/stop",
    reason:
      "DEBT. Stop sibling of environment/ensure — same cloud-sandbox exclusion; pinned in the same source test.",
  },
  {
    method: "GET",
    path: "/v1/git/:*/fast-boot-bundle",
    reason:
      "DEBT, not a considered exemption. Route shipped with the fast-git-boot work (#6976) but the manifest was not regenerated then; the canonical regen for the session-environment routes surfaced it. Nothing covers it — this entry keeps the gap visible instead of re-hiding it behind a stale manifest.",
  },
];

export const externalRoutes: AllowEntry[] = [
  { method: "GET", path: "/v1/llm/models", reason: "llm-gateway standalone service (gateway-*.kortix.com), not in the main API manifest" },
  { method: "GET", path: "/v1/llm/health", reason: "main-API bridge into the llm-gateway wildcard mount; exercised by GW-1b but not emitted by the static route manifest" },
  { method: "GET", path: "/v1/llm/v1/models", reason: "main-API llm-gateway compatibility alias mounted behind the dynamic /v1/llm bridge" },
  { method: "GET", path: "/v1/models", reason: "llm-gateway model-catalog alias" },
  { method: "GET", path: "/v1/openai/models", reason: "llm-gateway OpenAI-compat catalog alias" },
  { method: "POST", path: "/v1/chat/completions", reason: "llm-gateway chat completions" },
  { method: "POST", path: "/v1/llm/chat/completions", reason: "llm-gateway chat completions alias" },
  { method: "POST", path: "/v1/llm/v1/chat/completions", reason: "main-API llm-gateway OpenAI compatibility alias mounted behind the dynamic /v1/llm bridge" },
  { method: "POST", path: "/v1/llm/messages", reason: "main-API bridge into the llm-gateway Anthropic Messages ingress" },
  { method: "POST", path: "/v1/llm/v1/messages", reason: "main-API llm-gateway Anthropic compatibility alias mounted behind the dynamic /v1/llm bridge" },
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
