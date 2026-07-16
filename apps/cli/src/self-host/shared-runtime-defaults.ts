// Single source of truth for the target-AGNOSTIC runtime env defaults shared by
// every self-host flavor (docker "this machine", AWS EC2 appliance, bare VPS).
// These are semantic product defaults — auth behavior, sandbox provider, feature
// flags — that must be IDENTICAL everywhere. Only genuinely target-specific
// values (public URLs, image refs, host ports, AWS ARNs) live in the per-target
// generators, which spread these in.
//
// Historically the docker and AWS paths each hard-coded their own copy; they
// drifted (the AWS copy required email confirmation while docker auto-confirmed),
// which made the first account impossible on a fresh appliance with no SMTP. One
// object prevents that class of drift.

/**
 * Auth behavior. Defaults make a fresh install usable with NO SMTP configured:
 * email signups auto-confirm and the sign-in UI leads with password (not
 * magic-link, which needs email). Operators enable email/magic-link — and flip
 * ENABLE_EMAIL_AUTOCONFIRM to 'false' — once they configure real SMTP.
 */
export const SHARED_AUTH_DEFAULTS: Record<string, string> = {
  DISABLE_SIGNUP: 'false',
  ENABLE_EMAIL_SIGNUP: 'true',
  ENABLE_EMAIL_AUTOCONFIRM: 'true',
  ENABLE_ANONYMOUS_USERS: 'false',
  ENABLE_PHONE_SIGNUP: 'false',
  ENABLE_PHONE_AUTOCONFIRM: 'false',
  // Sign-in UI method order. Password-first so no email is required out of the
  // box; add 'magic' after SMTP is configured.
  KORTIX_PUBLIC_AUTH_METHODS: 'password',
};

/** Agent code-execution sandbox provider (Daytona SaaS by default). */
export const SHARED_SANDBOX_DEFAULTS: Record<string, string> = {
  ALLOWED_SANDBOX_PROVIDERS: 'daytona',
  DAYTONA_SERVER_URL: 'https://app.daytona.io/api',
  DAYTONA_TARGET: 'us',
};

/**
 * Configuration feature flags: landing-page disable, enterprise license, and
 * billing. A fresh self-host runs on the free-tier entitlement set and has
 * billing disabled (no Stripe keys to configure). The marketing/landing site
 * is DEACTIVATED by default (KORTIX_PUBLIC_DISABLE_LANDING_PAGE='true') — a
 * self-host is an app deployment, not a marketing site, so every marketing
 * route auto-redirects to the app (see apps/web middleware). `kortix self-host
 * configure` / the init wizard / --landing, --no-landing, --enterprise-license
 * flip these; they are ordinary runtime env, so they survive
 * `kortix self-host update` unchanged (only the image tags move) and are
 * explicit in .env instead of only hard-coded into the compose template.
 */
export const SHARED_FEATURE_FLAG_DEFAULTS: Record<string, string> = {
  // Marketing site off by default on self-host — redirect straight to the app.
  KORTIX_PUBLIC_DISABLE_LANDING_PAGE: 'true',
  ENTERPRISE_LICENSE_AVAILABLE: 'false',
  KORTIX_BILLING_INTERNAL_ENABLED: 'false',
  KORTIX_PUBLIC_BILLING_ENABLED: 'false',
  // Pipedream-backed connector UI (the "Connect your tools" onboarding step,
  // the "Easy connect" app catalogue) off by default — a fresh self-host has
  // no PIPEDREAM_CLIENT_ID/SECRET/PROJECT_ID configured, and those surfaces
  // would otherwise dead-end in a 501. `kortix self-host configure` flips
  // this to 'true' once Pipedream credentials are set (see selfHostConfigure
  // in commands/self-host.ts). Custom connectors (OpenAPI/GraphQL/MCP/HTTP)
  // and Slack/email channels are unaffected — they don't depend on Pipedream.
  KORTIX_PUBLIC_CONNECTORS_ENABLED: 'false',
  // Account-creation restriction: DEFAULT ON for self-host — a VPS operator
  // usually wants to be the only one who can spin up new organizations on
  // their own instance. Signups, existing teams, and SSO/JIT membership are
  // entirely unaffected; only POST /v1/accounts (creating an ADDITIONAL/org
  // account) is gated to platform admins (KORTIX_PLATFORM_ADMIN_EMAILS) — see
  // registerAccountRoutes() in apps/api/src/accounts/core/accounts.ts.
  // KORTIX_PUBLIC_RESTRICT_ACCOUNT_CREATION mirrors it on the frontend to
  // hide "New account" UI for non-admins. `kortix self-host init/configure`'s
  // deployment-shape question (promptFeatureFlags) flips both; disable via
  // `env set KORTIX_RESTRICT_ACCOUNT_CREATION=false
  // KORTIX_PUBLIC_RESTRICT_ACCOUNT_CREATION=false` or `--no-restrict-account-creation`.
  KORTIX_RESTRICT_ACCOUNT_CREATION: 'true',
  KORTIX_PUBLIC_RESTRICT_ACCOUNT_CREATION: 'true',
};

/** Every target-agnostic default in one object, for a single spread. */
export const SHARED_SELF_HOST_DEFAULTS: Record<string, string> = {
  ...SHARED_AUTH_DEFAULTS,
  ...SHARED_SANDBOX_DEFAULTS,
  ...SHARED_FEATURE_FLAG_DEFAULTS,
};
