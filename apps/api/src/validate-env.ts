import { envSchema, type Env } from "./env-schema";
import { parseAllowedProviders } from "./providers-config";

type EnvIssue = { var: string; message: string; level: "error" | "warn" };
type RawEnv = Env | Record<string, string | undefined>;

function checkProviders(raw: RawEnv, issues: EnvIssue[]): void {
  // On the managed cloud (billing on) a missing provider key is a hard error —
  // sessions are the product. On self-host it is a WARNING: the operator sets
  // the key after first boot (dashboard-first onboarding); the server must
  // start so they can reach that dashboard at all. Sandbox creation fails with
  // a clear error until the key lands.
  const providers = parseAllowedProviders((raw as any).ALLOWED_SANDBOX_PROVIDERS || '');
  const billingOn =
    (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === 'true' ||
    (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === true;
  const providerKeyLevel: 'error' | 'warn' = billingOn ? 'error' : 'warn';
  const providerKeySuffix = billingOn
    ? ''
    : ' — agent sessions will fail until it is set (kortix self-host env set ...)';
  for (const [provider, keys] of [
    ['daytona', ['DAYTONA_API_KEY', 'DAYTONA_SERVER_URL', 'DAYTONA_TARGET']],
    ['platinum', ['PLATINUM_API_KEY', 'PLATINUM_API_URL']],
    ['e2b', ['E2B_API_KEY']],
  ] as const) {
    if (!providers.includes(provider)) continue;
    for (const key of keys) {
      if (!raw[key]) issues.push({
        var: key,
        message: `Required when ALLOWED_SANDBOX_PROVIDERS includes "${provider}"${providerKeySuffix}`,
        level: providerKeyLevel,
      });
    }
  }
}

function checkBilling(raw: RawEnv, issues: EnvIssue[]): void {
  const billingWillBeEnabled =
    (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === 'true' ||
    (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === true;
  if (billingWillBeEnabled) for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] as const) {
    if (!raw[key]) issues.push({ var: key, message: 'Required when KORTIX_BILLING_INTERNAL_ENABLED=true', level: 'error' });
  }
}

function checkConfigReleases(raw: RawEnv, issues: EnvIssue[], billingOn: boolean): void {
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

function checkGithub(raw: RawEnv, issues: EnvIssue[]): void {
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

function checkTunnel(raw: RawEnv, issues: EnvIssue[]): void {
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

function checkUrl(raw: RawEnv, issues: EnvIssue[], billingOn: boolean, result: ReturnType<typeof envSchema.safeParse>): void {
  // Auto-derive from PORT for self-host/dev — fatal when billing is enabled
  // (you can't bill against an unreachable origin).
  if (!raw.KORTIX_URL) {
    const port = (raw as any).PORT || '8008';
    if (billingOn) {
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

function checkWarnings(raw: RawEnv, issues: EnvIssue[]): void {
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

function collectSchemaIssues(result: ReturnType<typeof envSchema.safeParse>, issues: EnvIssue[]): void {
  if (!result.success) for (const issue of result.error.issues) {
    issues.push({ var: issue.path.join('.'), message: issue.message, level: 'error' });
  }
}

function formatBootError(issues: EnvIssue[], level: 'error' | 'warn'): void {
  const entries = issues.filter((issue) => issue.level === level);
  if (!entries.length) return;
  const color = level === 'warn' ? '33' : '31';
  const print = level === 'warn' ? console.warn : console.error;
  const line = `\x1b[${color}m${'='.repeat(70)}\x1b[0m`;
  print('');
  print(line);
  print(level === 'warn'
    ? '\x1b[33m  kortix-api: Environment warnings\x1b[0m'
    : '\x1b[31m  kortix-api: Environment validation FAILED — server cannot start\x1b[0m');
  print(line);
  for (const entry of entries) print(`\x1b[${color}m  ${entry.var.padEnd(40)} ${entry.message}\x1b[0m`);
  print(line);
  print('');
  if (level === 'error') {
    print('\x1b[31m  Fix the above in your .env file and restart.\x1b[0m');
    print('');
  }
}

export function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  const issues: EnvIssue[] = [];

  collectSchemaIssues(result, issues);

  // Use raw values for conditional checks (schema may have failed)
  const raw = result.success ? result.data : (process.env as Record<string, string | undefined>);

  const billingOn = (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === "true" || (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === true;
  checkProviders(raw, issues);
  checkBilling(raw, issues);
  checkConfigReleases(raw, issues, billingOn);
  checkGithub(raw, issues);
  checkTunnel(raw, issues);
  checkUrl(raw, issues, billingOn, result);
  checkWarnings(raw, issues);
  const warnings = issues.filter((i) => i.level === 'warn');
  formatBootError(issues, 'warn');
  formatBootError(issues, 'error');
  if (issues.some((issue) => issue.level === 'error')) process.exit(1);

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
