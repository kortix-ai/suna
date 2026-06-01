/**
 * Single source of truth for what a sandbox is allowed to receive in its
 * environment.
 *
 * Hard rule: a sandbox NEVER holds a real upstream provider secret, and no
 * provider injects the per-service router URLs. The runtime needs only
 * `KORTIX_TOKEN` + `KORTIX_API_URL`; the tools derive every router endpoint
 * (`${KORTIX_API_URL}/v1/router/{service}`) from those two and authenticate
 * with `KORTIX_TOKEN`, and the kortix-api router injects the real upstream key
 * server-side. The only credentials that legitimately live inside a sandbox
 * are that `KORTIX_TOKEN` (and its auth aliases) plus per-session tokens we
 * mint explicitly.
 *
 * See router/config/proxy-services.ts for the upstream keys these map to.
 */

/**
 * Auth/identity credentials we DO set into the sandbox on purpose — the
 * sandbox service key (+ its aliases) and per-session tokens. Everything else
 * matching a secret shape is stripped.
 */
const SANDBOX_ALLOWED_CREDENTIALS: ReadonlySet<string> = new Set([
  'KORTIX_TOKEN',
  'INTERNAL_SERVICE_KEY',
  'TUNNEL_TOKEN',
  'KORTIX_CLI_TOKEN',
  'KORTIX_EXECUTOR_TOKEN',
]);

/**
 * Raw upstream provider secrets that must NEVER be injected into a sandbox.
 * These are reached through the router with `KORTIX_TOKEN`. Mirrors the
 * `getKortixApiKey` keys in router/config/proxy-services.ts.
 */
const SANDBOX_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'TAVILY_API_KEY',
  'SERPER_API_KEY',
  'FIRECRAWL_API_KEY',
  'REPLICATE_API_TOKEN',
  'CONTEXT7_API_KEY',
  // Platform infra secrets that never belong in a sandbox and don't match the
  // pattern below.
  'DATABASE_URL',
  'DAYTONA_API_KEY',
]);

/**
 * Conservative secret-shaped suffix match — catches anything secret-looking
 * (Stripe, Supabase service-role keys, encryption keys, …) that may live in
 * the API server's env file, so none of it can leak into a sandbox. The
 * credentials we inject on purpose are exempted in `isForbiddenSandboxEnv`.
 */
const SANDBOX_SECRET_PATTERN = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_SALT|_CREDENTIALS?)$/i;

/**
 * Whether an env var must NOT be forwarded into a sandbox. The auth credentials
 * we set explicitly are exempt; everything that names a provider key or matches
 * a secret shape is forbidden.
 */
export function isForbiddenSandboxEnv(name: string): boolean {
  if (SANDBOX_ALLOWED_CREDENTIALS.has(name)) return false;
  if (SANDBOX_FORBIDDEN_KEYS.has(name)) return true;
  return SANDBOX_SECRET_PATTERN.test(name);
}
