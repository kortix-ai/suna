import { hydrateEnvironmentSecret } from '@kortix/shared';
import { z } from 'zod';
import { envSchema } from './env-schema';

hydrateEnvironmentSecret();

// ─── Types ──────────────────────────────────────────────────────────────────

export type SandboxProviderName = 'daytona' | 'platinum' | 'e2b';
type InternalKortixEnv = 'dev' | 'staging' | 'prod' | 'preview';

// ─── Validation + Conditional Checks ────────────────────────────────────────

type EnvIssue = { var: string; message: string; level: 'error' | 'warn' };

// Recognised provider names. Source-of-truth for what can legally appear in
// ALLOWED_SANDBOX_PROVIDERS — adding a new provider is a one-place change
// here plus a case in `getProvider()` in platform/providers/index.ts.
export const KNOWN_PROVIDERS: readonly SandboxProviderName[] = [
  'daytona',
  'platinum',
  'e2b',
] as const;

/**
 * Parse comma-separated provider list (e.g. "daytona,platinum"). `fallback` is
 * returned both when `raw` is empty and when every entry in it is unrecognised
 * — kept as a parameter (rather than hardcoding `['daytona']`) so a caller
 * whose empty/all-invalid answer should mean "nothing enabled" does not
 * silently inherit ALLOWED_SANDBOX_PROVIDERS' "default to daytona" safety
 * belt.
 */
export function parseAllowedProviders(
  raw: string,
  fallback: SandboxProviderName[] = ['daytona'],
): SandboxProviderName[] {
  if (!raw) return fallback;
  const names = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid: SandboxProviderName[] = [];
  for (const n of names) {
    if ((KNOWN_PROVIDERS as readonly string[]).includes(n)) {
      const known = n as SandboxProviderName;
      if (!valid.includes(known)) valid.push(known);
    } else {
      console.warn(
        `[config] Unknown sandbox provider "${n}" in ALLOWED_SANDBOX_PROVIDERS - ignored`,
      );
    }
  }
  return valid.length > 0 ? valid : fallback;
}

type RawEnv = z.infer<typeof envSchema> | Record<string, string | undefined>;

function collectSchemaIssues(
  result: ReturnType<typeof envSchema.safeParse>,
  issues: EnvIssue[],
): void {
  // ── Collect Zod schema errors ──────────────────────────────────────────
  if (!result.success) {
    for (const issue of result.error.issues) {
      const varName = issue.path.join('.');
      issues.push({ var: varName, message: issue.message, level: 'error' });
    }
  }
}

function collectProviderCredentialIssues(
  raw: RawEnv,
  billingOn: boolean,
  issues: EnvIssue[],
): void {
  // ── Conditional: sandbox provider credentials ───────────────────────────
  // On the managed cloud (billing on) a missing provider key is a hard error —
  // sessions are the product. On self-host it is a WARNING: the operator sets
  // the key after first boot (dashboard-first onboarding); the server must
  // start so they can reach that dashboard at all. Sandbox creation fails with
  // a clear error until the key lands.
  const providers = parseAllowedProviders((raw as any).ALLOWED_SANDBOX_PROVIDERS || '');
  const providerKeyLevel: 'error' | 'warn' = billingOn ? 'error' : 'warn';
  const providerKeySuffix = billingOn
    ? ''
    : ' — agent sessions will fail until it is set (kortix self-host env set ...)';
  if (providers.includes('daytona')) {
    if (!raw.DAYTONA_API_KEY)
      issues.push({
        var: 'DAYTONA_API_KEY',
        message: `Required when ALLOWED_SANDBOX_PROVIDERS includes "daytona"${providerKeySuffix}`,
        level: providerKeyLevel,
      });
    if (!raw.DAYTONA_SERVER_URL)
      issues.push({
        var: 'DAYTONA_SERVER_URL',
        message: `Required when ALLOWED_SANDBOX_PROVIDERS includes "daytona"${providerKeySuffix}`,
        level: providerKeyLevel,
      });
    if (!raw.DAYTONA_TARGET)
      issues.push({
        var: 'DAYTONA_TARGET',
        message: `Required when ALLOWED_SANDBOX_PROVIDERS includes "daytona"${providerKeySuffix}`,
        level: providerKeyLevel,
      });
  }
  if (providers.includes('platinum')) {
    if (!raw.PLATINUM_API_KEY)
      issues.push({
        var: 'PLATINUM_API_KEY',
        message: `Required when ALLOWED_SANDBOX_PROVIDERS includes "platinum"${providerKeySuffix}`,
        level: providerKeyLevel,
      });
    if (!raw.PLATINUM_API_URL)
      issues.push({
        var: 'PLATINUM_API_URL',
        message: `Required when ALLOWED_SANDBOX_PROVIDERS includes "platinum"${providerKeySuffix}`,
        level: providerKeyLevel,
      });
  }
  if (providers.includes('e2b') && !raw.E2B_API_KEY) {
    issues.push({
      var: 'E2B_API_KEY',
      message: `Required when ALLOWED_SANDBOX_PROVIDERS includes "e2b"${providerKeySuffix}`,
      level: providerKeyLevel,
    });
  }
}

function collectBillingIssues(
  raw: RawEnv,
  billingWillBeEnabled: boolean,
  issues: EnvIssue[],
): void {
  // ── Conditional: Billing enabled → need Stripe keys ────────────────────
  if (billingWillBeEnabled) {
    if (!raw.STRIPE_SECRET_KEY)
      issues.push({
        var: 'STRIPE_SECRET_KEY',
        message: 'Required when KORTIX_BILLING_INTERNAL_ENABLED=true',
        level: 'error',
      });
    if (!raw.STRIPE_WEBHOOK_SECRET)
      issues.push({
        var: 'STRIPE_WEBHOOK_SECRET',
        message: 'Required when KORTIX_BILLING_INTERNAL_ENABLED=true',
        level: 'error',
      });
  }
}

function collectConfigReleaseIssues(raw: RawEnv, billingOn: boolean, issues: EnvIssue[]): void {
  // ── Conditional: config releases on → need the ONE object store ────────
  // `CONFIG_RELEASES_ENABLED` is the operator switch and defaults to FALSE
  // while the rollout runs. An environment turns it on together with the
  // bucket, and only then can a project opt in
  // (the per-project flag itself is OFF by default) and publish config
  // archives from that moment on. They go through the API's one
  // object store (src/object-store/s3.ts); there is no second store and no
  // fallback path that quietly writes somewhere else. Unset ⇒ every archive
  // request rebuilds from the Git mirror, every time, for every box.
  // Managed cloud (billing on) is a hard error — a deploy that forgot the
  // bucket must not reach users. Self-host warns and boots: the store is a
  // cache, and an operator upgrading a container with a stale env block must
  // not be locked out of their own dashboard.
  const configReleasesOn =
    (raw as any).CONFIG_RELEASES_ENABLED === 'true' || (raw as any).CONFIG_RELEASES_ENABLED === true;
  if (configReleasesOn) {
    const bucket = String((raw as any).KORTIX_CONFIG_ARCHIVE_S3_BUCKET ?? '').trim();
    const endpoint = String((raw as any).KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT ?? '').trim();
    const keyId = String((raw as any).KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID ?? '').trim();
    const keySecret = String((raw as any).KORTIX_CONFIG_ARCHIVE_S3_SECRET_ACCESS_KEY ?? '').trim();
    if (!bucket) {
      issues.push({
        var: 'KORTIX_CONFIG_ARCHIVE_S3_BUCKET',
        message: billingOn
          ? 'Required when CONFIG_RELEASES_ENABLED is on — no config archive is stored and every box rebuilds from the Git mirror'
          : 'Not set — config archives are not cached; every box rebuilds them from the Git mirror (set the KORTIX_CONFIG_ARCHIVE_S3_* block, or CONFIG_RELEASES_ENABLED=false)',
        level: billingOn ? 'error' : 'warn',
      });
    } else if (endpoint && !(keyId && keySecret)) {
      // A custom S3 endpoint (Supabase Storage, MinIO) never has a task role.
      issues.push({
        var: 'KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID',
        message:
          'Required with KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT — an S3-compatible endpoint has no AWS task role to fall back to',
        level: 'error',
      });
    }
  }
}

function collectGitHubAppIssues(raw: RawEnv, issues: EnvIssue[]): void {
  // ── Conditional: GitHub App configured → need its OAuth client too ─────
  // The App's own OAuth client is what proves "this GitHub user is you" when
  // linking an installation to an account (POST /projects/github/installations/
  // {linkable,link} need a user token from it). Without the pair, that flow
  // dead-ends at `?error=oauth_not_configured` — a redirect parameter in a
  // browser, with nothing said server-side. Every environment ran that way
  // unnoticed because these vars are read straight from process.env and so
  // never appeared in this report. Warn, don't fail: the App still signs its
  // own JWT and managed git keeps working without an OAuth client.
  const githubAppConfigured = Boolean(
    (raw as any).KORTIX_GITHUB_APP_ID || (raw as any).KORTIX_GITHUB_APP_PRIVATE_KEY,
  );
  if (githubAppConfigured) {
    const clientId = (raw as any).KORTIX_GITHUB_APP_CLIENT_ID || (raw as any).GITHUB_APP_CLIENT_ID;
    const clientSecret =
      (raw as any).KORTIX_GITHUB_APP_CLIENT_SECRET || (raw as any).GITHUB_APP_CLIENT_SECRET;
    const oauthHint =
      'Set it (or complete the manifest setup flow) or GitHub account linking fails with oauth_not_configured';
    if (!clientId)
      issues.push({ var: 'KORTIX_GITHUB_APP_CLIENT_ID', message: oauthHint, level: 'warn' });
    if (!clientSecret)
      issues.push({ var: 'KORTIX_GITHUB_APP_CLIENT_SECRET', message: oauthHint, level: 'warn' });
  }
}

function collectTunnelIssues(raw: RawEnv, issues: EnvIssue[]): void {
  // ── Conditional: Tunnel enabled → need signing secret ──────────────────
  const tunnelEnabled =
    (raw as any).TUNNEL_ENABLED !== 'false' && (raw as any).TUNNEL_ENABLED !== false;
  if (tunnelEnabled && !raw.TUNNEL_SIGNING_SECRET) {
    issues.push({
      var: 'TUNNEL_SIGNING_SECRET',
      message: 'Required when tunnel is enabled — protects device-handoff token derivation',
      level: 'error',
    });
  } else if (
    tunnelEnabled &&
    typeof raw.TUNNEL_SIGNING_SECRET === 'string' &&
    Buffer.byteLength(raw.TUNNEL_SIGNING_SECRET, 'utf8') < 24
  ) {
    issues.push({
      var: 'TUNNEL_SIGNING_SECRET',
      message: 'Must contain at least 24 bytes of secret material',
      level: 'error',
    });
  }
}

function collectKortixUrlIssues(
  raw: RawEnv,
  result: ReturnType<typeof envSchema.safeParse>,
  billingWillBeEnabled: boolean,
  issues: EnvIssue[],
): void {
  // ── Conditional: KORTIX_URL — required for sandbox routing ──────────────
  // Auto-derive from PORT for self-host/dev — fatal when billing is enabled
  // (you can't bill against an unreachable origin).
  if (!raw.KORTIX_URL) {
    const port = (raw as any).PORT || '8008';
    if (billingWillBeEnabled) {
      issues.push({
        var: 'KORTIX_URL',
        message:
          'Required when KORTIX_BILLING_INTERNAL_ENABLED=true — sandbox routing and health checks will break',
        level: 'error',
      });
    } else {
      // Auto-derive so dev/self-host "just works". KORTIX_URL is the public
      // API origin/base; individual callers append /v1, /v1/router, etc.
      const derived = `http://localhost:${port}`;
      process.env.KORTIX_URL = derived;
      if (result.success) (result.data as any).KORTIX_URL = derived;
      console.warn(`[config] KORTIX_URL not set — auto-derived: ${derived}`);
      issues.push({
        var: 'KORTIX_URL',
        message: `Not set — auto-derived to ${derived} (add to .env to silence this)`,
        level: 'warn',
      });
    }
  }
}

function collectOpenRouterWarnings(raw: RawEnv, issues: EnvIssue[]): void {
  // ── Warnings (non-fatal but worth knowing) ─────────────────────────────
  if (!raw.OPENROUTER_API_KEY) {
    issues.push({
      var: 'OPENROUTER_API_KEY',
      message: 'Not set — the optional OpenRouter router is unavailable',
      level: 'warn',
    });
  }
  if (raw.LLM_GATEWAY_ENABLED === 'true' && raw.KORTIX_MANAGED_PROVIDER_ENABLED === 'true' && !raw.OPENROUTER_API_KEY) {
    issues.push({
      var: 'OPENROUTER_API_KEY',
      message: 'Gateway is on but OPENROUTER_API_KEY is unset — Kortix managed models are unavailable',
      level: 'warn',
    });
  }
}

function validateEnv(): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(process.env);

  const issues: EnvIssue[] = [];
  collectSchemaIssues(result, issues);

  // Use raw values for conditional checks (schema may have failed)
  const raw = result.success ? result.data : (process.env as Record<string, string | undefined>);

  // billingOn and billingWillBeEnabled are hoisted from the checks below so each
  // check block stays a verbatim function of its own. Same expressions, same point.
  const billingOn =
    (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === 'true' ||
    (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === true;
  const billingWillBeEnabled =
    (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === 'true' ||
    (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === true;

  collectProviderCredentialIssues(raw, billingOn, issues);
  collectBillingIssues(raw, billingWillBeEnabled, issues);
  collectConfigReleaseIssues(raw, billingOn, issues);
  collectGitHubAppIssues(raw, issues);
  collectTunnelIssues(raw, issues);
  collectKortixUrlIssues(raw, result, billingWillBeEnabled, issues);
  collectOpenRouterWarnings(raw, issues);

  // ── Print results ─────────────────────────────────────────────────────
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warn');

  if (warnings.length > 0) {
    console.warn('');
    console.warn('\x1b[33m' + '='.repeat(70) + '\x1b[0m');
    console.warn('\x1b[33m  kortix-api: Environment warnings\x1b[0m');
    console.warn('\x1b[33m' + '='.repeat(70) + '\x1b[0m');
    for (const w of warnings) {
      console.warn(`\x1b[33m  ${w.var.padEnd(40)} ${w.message}\x1b[0m`);
    }
    console.warn('\x1b[33m' + '='.repeat(70) + '\x1b[0m');
    console.warn('');
  }

  if (errors.length > 0) {
    console.error('');
    console.error('\x1b[31m' + '='.repeat(70) + '\x1b[0m');
    console.error(
      '\x1b[31m  kortix-api: Environment validation FAILED — server cannot start\x1b[0m',
    );
    console.error('\x1b[31m' + '='.repeat(70) + '\x1b[0m');
    for (const e of errors) {
      console.error(`\x1b[31m  ${e.var.padEnd(40)} ${e.message}\x1b[0m`);
    }
    console.error('\x1b[31m' + '='.repeat(70) + '\x1b[0m');
    console.error('');
    console.error('\x1b[31m  Fix the above in your .env file and restart.\x1b[0m');
    console.error('');
    process.exit(1);
  }

  if (!result.success) {
    // Should not be reachable (errors already handled above) but safety net
    console.error('[config] Unexpected validation failure:', result.error.format());
    process.exit(1);
  }

  console.log(
    `[config] Environment validated (${Object.keys(envSchema.shape).length} vars, ${warnings.length} warnings)`,
  );
  return result.data;
}

// ─── Run Validation at Module Load ──────────────────────────────────────────

const env = validateEnv();

// ─── Parse Providers ────────────────────────────────────────────────────────

const allowedProviders = parseAllowedProviders(env.ALLOWED_SANDBOX_PROVIDERS);

export { env, allowedProviders };
export type { InternalKortixEnv };
