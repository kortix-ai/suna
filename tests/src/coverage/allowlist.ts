export interface AllowEntry {
  method: string;
  path: string;
  reason: string;
}

/**
 * DEPRECATED `/channels/*` aliases (apps/api/src/projects/routes/connectors-channels-compat.ts).
 * Each delegates to the canonical `/connectors/channels/*` handler via the SAME
 * lookup/auth/handler path — and those canonical routes ARE flow-covered
 * (CHN-*/MEET-*). The aliases exist only so sandbox images with a baked
 * `slack-cli`, and already-installed `kortix` CLIs, keep working until images and
 * CLIs roll over; they are deleted after that. Flow-testing them would duplicate
 * the canonical flows byte-for-byte rather than assert anything new.
 */
const DEPRECATED_CHANNEL_ALIAS_REASON =
  "deprecated /channels/* alias — delegates to the flow-covered /connectors/channels/* handler; kept for baked sandbox images + installed kortix CLIs until rollover, then deleted";

const DEPRECATED_CHANNEL_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["GET", "/v1/projects/:*/channels/slack/installation"],
  ["DELETE", "/v1/projects/:*/channels/slack/installation"],
  ["GET", "/v1/projects/:*/channels/slack/mode"],
  ["POST", "/v1/projects/:*/channels/slack/connect"],
  ["GET", "/v1/projects/:*/channels/slack/file"],
  ["POST", "/v1/projects/:*/channels/slack/file/upload"],
  ["POST", "/v1/projects/:*/channels/slack/bind-thread"],
  ["GET", "/v1/projects/:*/channels/teams/installation"],
  ["DELETE", "/v1/projects/:*/channels/teams/installation"],
  ["GET", "/v1/projects/:*/channels/teams/mode"],
  ["GET", "/v1/projects/:*/channels/teams/manifest"],
  ["POST", "/v1/projects/:*/channels/teams/connect"],
  ["GET", "/v1/projects/:*/channels/teams/file"],
  ["POST", "/v1/projects/:*/channels/teams/file/upload"],
  ["GET", "/v1/projects/:*/channels/email/installation"],
  ["DELETE", "/v1/projects/:*/channels/email/installation"],
  ["PATCH", "/v1/projects/:*/channels/email/installation"],
  ["GET", "/v1/projects/:*/channels/email/mode"],
  ["POST", "/v1/projects/:*/channels/email/connect"],
  ["GET", "/v1/projects/:*/channels/meet/voices"],
  ["PUT", "/v1/projects/:*/channels/meet/name"],
  ["PUT", "/v1/projects/:*/channels/meet/voice"],
  ["POST", "/v1/projects/:*/channels/meet/voices/:*/preview"],
  ["POST", "/v1/projects/:*/channels/meet/speak"],
];

export const uncoveredAllow: AllowEntry[] = [
  ...DEPRECATED_CHANNEL_ALIASES.map(([method, path]) => ({
    method,
    path,
    reason: DEPRECATED_CHANNEL_ALIAS_REASON,
  })),
  {
    method: "PUT",
    path: "/v1/executor/projects/:*/connectors/:*/sensitive",
    reason:
      "executor-scoped runtime endpoint — called by the in-sandbox executor with its own token, not by end-user clients; the user-facing equivalent is flow-covered",
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
