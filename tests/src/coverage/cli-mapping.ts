// CLI parity map — the source of truth for "which API routes are reachable
// from the `kortix` CLI." The cli-parity gate (check-cli-parity.ts) fails when
// a NEW route ships that is neither mapped here, exempted here, nor already in
// the frozen baseline (tests/spec/cli-parity-baseline.json). Same baseline-diff
// mechanism as the route-coverage gate (allowlist.ts + coverage-baseline.json):
// it only fails on regressions, never on the large pre-existing gap.
//
// To resolve a baseline gap: wire the route into the CLI, add a `cliMapped`
// entry, then run `npm --prefix tests run cli-parity -- --update-baseline` to
// lock in the improvement. `command` / `reason` are documentation (not verified
// against the CLI binary), the same trust model as allowlist.ts reasons.

export interface CliMapEntry {
  method: string;
  path: string;
  /** The CLI command that reaches this route. */
  command: string;
}

export interface CliExemptEntry {
  method: string;
  path: string;
  /** Why this route will never have a CLI command. */
  reason: string;
}

/** Routes with a working CLI command today. Grows over time as gaps close. */
export const cliMapped: CliMapEntry[] = [
  { method: "GET", path: "/v1/accounts/me", command: "kortix whoami" },
  { method: "GET", path: "/v1/projects", command: "kortix projects ls" },
  { method: "POST", path: "/v1/projects", command: "kortix ship" },
  { method: "GET", path: "/v1/projects/:*", command: "kortix projects info" },
  { method: "GET", path: "/v1/projects/:*/sessions", command: "kortix sessions ls" },
  { method: "POST", path: "/v1/projects/:*/sessions", command: "kortix sessions new" },
  { method: "GET", path: "/v1/projects/:*/change-requests", command: "kortix cr ls" },
  { method: "POST", path: "/v1/projects/:*/change-requests", command: "kortix cr open" },
];

/** Routes that will never have a CLI command — internal service-to-service
 *  calls, protocol endpoints (SCIM), inbound webhooks, infra probes, and the
 *  self-hosted setup wizard. */
export const cliExempt: CliExemptEntry[] = [
  { method: "GET", path: "/health/live", reason: "infra liveness/metrics endpoint, not a user action" },
  { method: "GET", path: "/health", reason: "infra liveness/metrics endpoint, not a user action" },
  { method: "POST", path: "/internal/gateway/authenticate", reason: "internal gateway-to-API call, not a user-facing action" },
  { method: "POST", path: "/internal/gateway/authorize", reason: "internal gateway-to-API call, not a user-facing action" },
  { method: "POST", path: "/internal/gateway/billing", reason: "internal gateway-to-API call, not a user-facing action" },
  { method: "POST", path: "/internal/gateway/budget-check", reason: "internal gateway-to-API call, not a user-facing action" },
  { method: "POST", path: "/internal/gateway/models", reason: "internal gateway-to-API call, not a user-facing action" },
  { method: "POST", path: "/internal/gateway/resolve-upstream", reason: "internal gateway-to-API call, not a user-facing action" },
  { method: "POST", path: "/internal/gateway/trace", reason: "internal gateway-to-API call, not a user-facing action" },
  { method: "POST", path: "/internal/gateway/usage", reason: "internal gateway-to-API call, not a user-facing action" },
  { method: "GET", path: "/metrics", reason: "infra liveness/metrics endpoint, not a user action" },
  { method: "DELETE", path: "/scim/v2/accounts/:*/Groups/:*", reason: "SCIM protocol endpoint consumed by identity providers, not by end users" },
  { method: "GET", path: "/scim/v2/accounts/:*/Groups/:*", reason: "SCIM protocol endpoint consumed by identity providers, not by end users" },
  { method: "PATCH", path: "/scim/v2/accounts/:*/Groups/:*", reason: "SCIM protocol endpoint consumed by identity providers, not by end users" },
  { method: "GET", path: "/scim/v2/accounts/:*/Groups", reason: "SCIM protocol endpoint consumed by identity providers, not by end users" },
  { method: "POST", path: "/scim/v2/accounts/:*/Groups", reason: "SCIM protocol endpoint consumed by identity providers, not by end users" },
  { method: "GET", path: "/scim/v2/accounts/:*/ServiceProviderConfig", reason: "SCIM protocol endpoint consumed by identity providers, not by end users" },
  { method: "DELETE", path: "/scim/v2/accounts/:*/Users/:*", reason: "SCIM protocol endpoint consumed by identity providers, not by end users" },
  { method: "GET", path: "/scim/v2/accounts/:*/Users/:*", reason: "SCIM protocol endpoint consumed by identity providers, not by end users" },
  { method: "PATCH", path: "/scim/v2/accounts/:*/Users/:*", reason: "SCIM protocol endpoint consumed by identity providers, not by end users" },
  { method: "GET", path: "/scim/v2/accounts/:*/Users", reason: "SCIM protocol endpoint consumed by identity providers, not by end users" },
  { method: "POST", path: "/scim/v2/accounts/:*/Users", reason: "SCIM protocol endpoint consumed by identity providers, not by end users" },
  { method: "POST", path: "/v1/billing/webhook/revenuecat", reason: "inbound billing webhook (Stripe/RevenueCat), not a user action" },
  { method: "POST", path: "/v1/billing/webhook/stripe", reason: "inbound billing webhook (Stripe/RevenueCat), not a user action" },
  { method: "POST", path: "/v1/billing/webhooks/revenuecat", reason: "inbound billing webhook (Stripe/RevenueCat), not a user action" },
  { method: "POST", path: "/v1/billing/webhooks/stripe", reason: "inbound billing webhook (Stripe/RevenueCat), not a user action" },
  { method: "GET", path: "/v1/openapi.json", reason: "OpenAPI document, not a user action" },
  { method: "POST", path: "/v1/setup-links/connector/:*/start", reason: "one-time setup link opened in a browser, not a CLI action" },
  { method: "GET", path: "/v1/setup-links/connector/:*", reason: "one-time setup link opened in a browser, not a CLI action" },
  { method: "GET", path: "/v1/setup-links/secret/:*", reason: "one-time setup link opened in a browser, not a CLI action" },
  { method: "POST", path: "/v1/setup-links/secret/:*", reason: "one-time setup link opened in a browser, not a CLI action" },
  { method: "POST", path: "/v1/setup/bootstrap-owner", reason: "self-hosted setup wizard app, not a general CLI action" },
  { method: "GET", path: "/v1/setup/health", reason: "self-hosted setup wizard app, not a general CLI action" },
  { method: "GET", path: "/v1/setup/install-status", reason: "self-hosted setup wizard app, not a general CLI action" },
  { method: "GET", path: "/v1/setup/sandbox-providers", reason: "self-hosted setup wizard app, not a general CLI action" },
  { method: "POST", path: "/v1/setup/setup-complete", reason: "self-hosted setup wizard app, not a general CLI action" },
  { method: "GET", path: "/v1/setup/setup-status", reason: "self-hosted setup wizard app, not a general CLI action" },
  { method: "GET", path: "/v1/setup/setup-wizard-step", reason: "self-hosted setup wizard app, not a general CLI action" },
  { method: "POST", path: "/v1/setup/setup-wizard-step", reason: "self-hosted setup wizard app, not a general CLI action" },
  { method: "GET", path: "/v1/setup/status", reason: "self-hosted setup wizard app, not a general CLI action" },
  { method: "POST", path: "/v1/webhooks/email/agentmail", reason: "inbound webhook receiver, not a user action" },
  { method: "POST", path: "/v1/webhooks/meet/realtime", reason: "inbound webhook receiver, not a user action" },
  { method: "POST", path: "/v1/webhooks/meet/status", reason: "inbound webhook receiver, not a user action" },
  { method: "POST", path: "/v1/webhooks/projects/:*/:*", reason: "inbound webhook receiver, not a user action" },
  { method: "POST", path: "/v1/webhooks/sandbox/daytona", reason: "inbound webhook receiver, not a user action" },
  { method: "POST", path: "/v1/webhooks/sandbox/platinum", reason: "inbound webhook receiver, not a user action" },
  { method: "POST", path: "/v1/webhooks/slack/:*/commands", reason: "inbound webhook receiver, not a user action" },
  { method: "POST", path: "/v1/webhooks/slack/:*/interactivity", reason: "inbound webhook receiver, not a user action" },
  { method: "GET", path: "/v1/webhooks/slack/:*/manifest", reason: "inbound webhook receiver, not a user action" },
  { method: "POST", path: "/v1/webhooks/slack/:*", reason: "inbound webhook receiver, not a user action" },
  { method: "POST", path: "/v1/webhooks/slack/commands", reason: "inbound webhook receiver, not a user action" },
  { method: "POST", path: "/v1/webhooks/slack/interactivity", reason: "inbound webhook receiver, not a user action" },
  { method: "GET", path: "/v1/webhooks/slack/oauth/callback", reason: "inbound webhook receiver, not a user action" },
  { method: "POST", path: "/v1/webhooks/slack", reason: "inbound webhook receiver, not a user action" },
  { method: "POST", path: "/v1/webhooks/telegram/:*", reason: "inbound webhook receiver, not a user action" },
];
