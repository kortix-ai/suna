/**
 * Typed environment/config resolution for ke2e.
 *
 * The suite is environment-agnostic: point it at a local dev API, dev-api.kortix.com,
 * or prod via env vars. Primary names are KE2E_(star), with E2E_(star) + standard fallbacks so
 * the existing gate5/playwright secrets keep working.
 *
 * Bun auto-loads a `.env` in the cwd, so local runs can drop secrets there.
 */

export type TargetName = "local" | "dev" | "prod" | "custom";

export interface Capabilities {
  /** Real Daytona sandbox provisioning available. */
  daytona: boolean;
  /** Freestyle managed git available. */
  freestyle: boolean;
  /** Stripe test-mode billing wired (webhook secret present). */
  stripe: boolean;
  /** Supabase service-role admin available (mint/confirm users). */
  supabaseAdmin: boolean;
  /** Direct DB access for GC of orphans + role states with no route. */
  database: boolean;
  /** Platform-admin token for /v1/ops/* + requireAdmin routes. */
  admin: boolean;
  /**
   * Runtime: OWNER was successfully funded via the real subscribe flow (set after
   * bootstrap). Billing-gated flows (sessions, paid subscribe) require this — it's
   * only achievable on a target whose Stripe account has the configured paid prices
   * (e.g. dev-api), so those flows skip on a local stack that lacks them.
   */
  funded: boolean;
}

export interface Env {
  /** API base, always /v1-suffixed, no trailing slash. e.g. http://localhost:8008/v1 */
  apiUrl: string;
  /** Dashboard/web origin (for CLI-login callback flows). */
  baseUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string | null;
  supabaseServiceRoleKey: string | null;
  databaseUrl: string | null;
  /** Seeded long-lived owner (confirmed, billing-capable). */
  ownerEmail: string | null;
  ownerPassword: string | null;
  /** Platform-admin bearer token (kortix_pat_* or kortix_*). */
  adminToken: string | null;
  /** Stripe TEST secret key — to confirm PaymentIntents in the real subscribe flow. */
  stripeSecretKey: string | null;
  /**
   * Stripe webhook signing secret (whsec_…). Lets the suite POST a validly-signed
   * `customer.subscription.updated` to /v1/billing/webhook/stripe so the real
   * credit-granting handler runs even on a target whose Stripe→API webhook isn't
   * delivered (e.g. dev-api). Only used as a fallback when credits don't land on
   * their own after subscribe.
   */
  stripeWebhookSecret: string | null;
  /** Required non-empty to run destructive (data-creating) flows. */
  liveConfirm: string | null;
  target: TargetName;
  capabilities: Capabilities;
  /** Email domain for synthetic principal accounts. */
  testEmailDomain: string;
}

function pick(...names: string[]): string | null {
  for (const n of names) {
    const v = process.env[n];
    if (v != null && v.trim() !== "") return v.trim();
  }
  return null;
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

function inferTarget(apiUrl: string): TargetName {
  const explicit = pick("KE2E_TARGET", "E2E_TARGET");
  if (explicit === "local" || explicit === "dev" || explicit === "prod" || explicit === "custom") {
    return explicit;
  }
  const host = (() => {
    try {
      return new URL(apiUrl).hostname;
    } catch {
      return "";
    }
  })();
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost")) return "local";
  if (host.startsWith("dev-api.") || host.startsWith("dev-")) return "dev";
  if (host === "api.kortix.com" || host.startsWith("api-prod.") || host === "kortix.com") return "prod";
  return "custom";
}

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;

  const apiUrl = stripTrailingSlash(
    pick("KE2E_API_URL", "E2E_API_URL", "NEXT_PUBLIC_BACKEND_URL") || "http://localhost:8008/v1",
  );
  const baseUrl = stripTrailingSlash(
    pick("KE2E_BASE_URL", "E2E_BASE_URL") || apiUrl.replace(/\/v1$/, "").replace("://api.", "://").replace("://dev-api.", "://dev."),
  );
  const supabaseUrl = stripTrailingSlash(
    pick("KE2E_SUPABASE_URL", "E2E_SUPABASE_URL", "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL") ||
      "http://127.0.0.1:54321",
  );
  const supabaseAnonKey = pick(
    "KE2E_SUPABASE_ANON_KEY",
    "SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  );
  const supabaseServiceRoleKey = pick(
    "KE2E_SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  const databaseUrl = pick("KE2E_DATABASE_URL", "E2E_DATABASE_URL");
  const ownerEmail = pick("KE2E_OWNER_EMAIL", "E2E_OWNER_EMAIL");
  const ownerPassword = pick("KE2E_OWNER_PASSWORD", "E2E_OWNER_PASSWORD");
  const adminToken = pick("KE2E_ADMIN_TOKEN", "E2E_ADMIN_TOKEN", "ADMIN_TOKEN");
  const stripeSecretKey = pick("KE2E_STRIPE_SECRET_KEY");
  const stripeWebhookSecret = pick("KE2E_STRIPE_WEBHOOK_SECRET");
  const liveConfirm = pick("KE2E_LIVE_CONFIRM");
  const target = inferTarget(apiUrl);

  const capabilities: Capabilities = {
    daytona: pick("KE2E_CAP_DAYTONA") !== "0",
    freestyle: pick("KE2E_CAP_FREESTYLE") !== "0",
    stripe: stripeSecretKey != null,
    supabaseAdmin: supabaseServiceRoleKey != null,
    database: databaseUrl != null,
    admin: adminToken != null,
    funded: false, // set true after a successful OWNER subscribe at bootstrap
  };

  cached = {
    apiUrl,
    baseUrl,
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceRoleKey,
    databaseUrl,
    ownerEmail,
    ownerPassword,
    adminToken,
    stripeSecretKey,
    stripeWebhookSecret,
    liveConfirm,
    target,
    capabilities,
    testEmailDomain: pick("KE2E_EMAIL_DOMAIN") || "ke2e.kortix.test",
  };
  return cached;
}

/**
 * Hard safety preflight before any destructive (data-creating) run.
 * Mirrors the getSafeTestDbUrl guard pattern: refuse to run against an env we
 * can't positively identify as a test/dev target, and require explicit confirm.
 */
export function assertSafeForDestructive(env: Env): void {
  if (env.target === "prod") {
    throw new Error(
      `Refusing to run destructive flows against a prod target (${env.apiUrl}). ` +
        `Prod runs must use --smoke (read-mostly) only.`,
    );
  }
  if (!env.liveConfirm) {
    throw new Error(
      "Destructive live flows require KE2E_LIVE_CONFIRM to be set (acknowledges that real " +
        "accounts/projects/sandboxes will be created and torn down against the target).",
    );
  }
}

export function describeEnv(env: Env): string {
  const caps = Object.entries(env.capabilities)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");
  return `target=${env.target} api=${env.apiUrl} caps=[${caps}]`;
}
