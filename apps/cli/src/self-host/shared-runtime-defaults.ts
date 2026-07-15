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
 * Configuration feature flags: single-account mode, landing-page
 * disable, enterprise license, and billing. Off by default — a fresh
 * self-host is multi-account-capable, shows the marketing landing page,
 * runs on the free-tier entitlement set, and has billing disabled (no
 * Stripe keys to configure). `kortix self-host configure` / the init wizard
 * / --single-account, --no-landing, --enterprise-license flip these; they
 * are ordinary runtime env, so they survive `kortix self-host update`
 * unchanged (only the image tags move) and are explicit in .env instead of
 * only hard-coded into the compose template.
 */
export const SHARED_FEATURE_FLAG_DEFAULTS: Record<string, string> = {
  KORTIX_SINGLE_ACCOUNT_MODE: 'false',
  KORTIX_PUBLIC_SINGLE_ACCOUNT_MODE: 'false',
  KORTIX_PUBLIC_DISABLE_LANDING_PAGE: 'false',
  ENTERPRISE_LICENSE_AVAILABLE: 'false',
  KORTIX_BILLING_INTERNAL_ENABLED: 'false',
  KORTIX_PUBLIC_BILLING_ENABLED: 'false',
};

/** Every target-agnostic default in one object, for a single spread. */
export const SHARED_SELF_HOST_DEFAULTS: Record<string, string> = {
  ...SHARED_AUTH_DEFAULTS,
  ...SHARED_SANDBOX_DEFAULTS,
  ...SHARED_FEATURE_FLAG_DEFAULTS,
};
