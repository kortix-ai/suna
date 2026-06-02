import { z } from 'zod';

/**
 * Running sandbox version.
 *
 * Source of truth: SANDBOX_VERSION env var, injected at container start
 * by deploy-zero-downtime.sh (extracted from the Docker image tag).
 * Falls back to 'unknown' only if the env var is missing.
 */
export const SANDBOX_VERSION = process.env.SANDBOX_VERSION || 'unknown';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SandboxProviderName = 'daytona' | 'local_docker';
type InternalKortixEnv = 'dev' | 'staging' | 'prod';

// ─── Zod Helpers ────────────────────────────────────────────────────────────

/** Optional string — defaults to empty string when missing or empty. */
const optStr = z.string().optional().default('');

/** Optional string with a custom default value. */
const optStrDefault = (def: string) => z.string().optional().default(def);

/** Optional URL string with a custom default. Not required, just validated if present. */
const optUrl = (def: string) =>
  z.string().optional().default(def).refine(
    (v) => v === '' || /^https?:\/\//.test(v),
    { message: 'Must be a valid HTTP(S) URL' },
  );

/** Optional int with a default. */
const optInt = (def: number) =>
  z.string().optional().default(String(def)).transform((v) => {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? def : n;
  });

/** Optional boolean — 'true' → true, anything else → false. */
const optBoolTrue = z.string().optional().default('true').transform((v) => v !== 'false');
const optBoolFalse = z.string().optional().default('false').transform((v) => v === 'true');

// ─── Env Schema ─────────────────────────────────────────────────────────────
//
// Every env var that kortix-api reads is declared here.
// Categories:
//   - REQUIRED:    server will not start without these
//   - CONDITIONAL: required when a related feature is enabled
//   - OPTIONAL:    graceful degradation or sane default if missing

const envSchema = z.object({

  // ── Core (required) ──────────────────────────────────────────────────────
  PORT:                        optInt(8008),

  // ── Database (REQUIRED) ──────────────────────────────────────────────────
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required — cannot start without a database'),

  // ── Supabase (REQUIRED) ──────────────────────────────────────────────────
  SUPABASE_URL: z.string().min(1, 'SUPABASE_URL is required').refine(
    (v) => /^https?:\/\//.test(v),
    { message: 'SUPABASE_URL must be a valid HTTP(S) URL' },
  ),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),

  // ── API Key Hashing (REQUIRED) ───────────────────────────────────────────
  API_KEY_SECRET: z.string().min(1, 'API_KEY_SECRET is required — API key hashing will fail'),

  // ── Internal Deployment Controls (optional, safe defaults for self-hosted) ─
  INTERNAL_KORTIX_ENV:              z.enum(['dev', 'staging', 'prod']).optional().default('dev'),
  // Master switch: turns on real billing (Stripe + credit ledger), makes
  // KORTIX_URL fatal-required, mounts the proxy-auth gate, hides /v1/setup.
  // Set to true on managed/cloud deployments; leave false for self-host + dev.
  KORTIX_BILLING_INTERNAL_ENABLED:  optBoolFalse,
  KORTIX_DEPLOYMENTS_ENABLED:       optBoolFalse,
  // EXPERIMENTAL: turns on the [[apps]] section in kortix.toml — manifest
  // parsing, CRUD routes, manual deploy, and the auto-deploy sweep. Off
  // by default until the wire is hardened.
  KORTIX_APPS_EXPERIMENTAL:         optBoolFalse,

  // ── Search Providers (optional — features degrade gracefully) ────────────
  TAVILY_API_URL:              optUrl('https://api.tavily.com'),
  TAVILY_API_KEY:              optStr,
  SERPER_API_URL:              optUrl('https://google.serper.dev'),
  SERPER_API_KEY:              optStr,

  // ── Proxy Providers (optional) ───────────────────────────────────────────
  FIRECRAWL_API_URL:           optUrl('https://api.firecrawl.dev'),
  FIRECRAWL_API_KEY:           optStr,
  REPLICATE_API_URL:           optUrl('https://api.replicate.com'),
  REPLICATE_API_TOKEN:         optStr,
  CONTEXT7_API_URL:            optUrl('https://context7.com'),
  CONTEXT7_API_KEY:            optStr,

  // ── Freestyle / Deployments (optional) ───────────────────────────────────
  FREESTYLE_API_URL:           optUrl('https://api.freestyle.sh'),
  FREESTYLE_API_KEY:           optStr,

  // ── Managed git (provider-agnostic via the git proxy) ────────────────────
  // MANAGED_GIT_PROVIDER selects the backend NEW managed repos provision on
  // ('github' default | 'freestyle'). The GitHub backend creates repos under
  // MANAGED_GIT_GITHUB_OWNER (a Kortix-owned org) via the Kortix App installed
  // there (MANAGED_GIT_GITHUB_INSTALL_ID). Reuses KORTIX_GITHUB_APP_* for the
  // App JWT. Each backend's isConfigured() checks its own vars, so leaving
  // these blank keeps the GitHub backend inert (Freestyle stays the default).
  MANAGED_GIT_PROVIDER:            optStr,
  MANAGED_GIT_GITHUB_OWNER:        optStr,
  MANAGED_GIT_GITHUB_INSTALL_ID:   optStr,
  // Optional straight org PAT for the managed org (the "one server-side key"
  // model, 1:1 with the old FREESTYLE_API_KEY). When set it takes precedence
  // over the GitHub App for managed-org admin ops (create/delete repo, invite
  // collaborator). Leave blank to use the App installation instead.
  MANAGED_GIT_GITHUB_TOKEN:        optStr,
  // When true, runtime clients (sandbox + `kortix` CLI) use the Kortix git
  // proxy as their git origin (auth = KORTIX_TOKEN) instead of the real host —
  // so a real GitHub/Freestyle credential never reaches a sandbox. Requires a
  // daemon snapshot that returns KORTIX_TOKEN for the proxy host (back-compat:
  // OFF leaves the direct clone-credential token flow untouched).
  KORTIX_GIT_PROXY:                optBoolFalse,
  // Warm sandbox pool (docs/specs/warm-pool.md). Default OFF — when enabled,
  // keep N pre-booted sandboxes per project to claim instantly.
  KORTIX_WARM_POOL_ENABLED:        optBoolFalse,
  // Global cap on total warm (pre-booted, unclaimed) sandboxes across all
  // projects — bounds idle cost + the Daytona quota.
  KORTIX_WARM_POOL_MAX_TOTAL:      optInt(50),
  // Only keep a warm pool for projects with a session in the last N days, so we
  // don't hold idle sandboxes for dormant projects.
  KORTIX_WARM_POOL_ACTIVE_DAYS:    optInt(7),

  // ── Legacy migration — reaching legacy JustAVPS VMs + backup storage ──────
  // The new backend has no JustAVPS provider, but it must reach legacy VMs to
  // back them up. VMs are reachable via the CF proxy at {slug}.{proxy domain};
  // exec goes through the Daytona toolbox API on that host. JUSTAVPS_API_* are
  // only needed to refresh an expired per-sandbox proxy token.
  JUSTAVPS_PROXY_DOMAIN:       optStrDefault('kortix.cloud'),
  JUSTAVPS_API_URL:            optStrDefault('http://localhost:3001'),
  JUSTAVPS_API_KEY:            optStr,
  // Supabase Storage bucket holding the durable per-sandbox backup bundle
  // (workspace files + OpenCode chat-history store). Source for rehydrate.
  LEGACY_MIGRATION_BACKUP_BUCKET: optStrDefault('legacy-migrations'),

  // ── Channels — Slack adapter (optional) ──────────────────────────────────
  SLACK_BOT_TOKEN:             optStr,
  SLACK_SIGNING_SECRET:        optStr,
  SLACK_TEAM_ID:               optStr,
  SLACK_CLIENT_ID:             optStr,
  SLACK_CLIENT_SECRET:         optStr,
  SLACK_REDIRECT_URI:          optStr,
  // Must stay in sync with the Slack app manifest used during channel setup;
  // anything narrower here means OAuth grants fewer scopes than the bot needs.
  SLACK_OAUTH_SCOPES:          optStrDefault('app_mentions:read,channels:history,channels:read,channels:join,chat:write,chat:write.public,files:read,files:write,groups:history,groups:read,im:history,im:read,im:write,mpim:history,mpim:read,reactions:read,reactions:write,users:read'),
  // Optional banner image rendered at the top of the App Home tab. Must be a
  // public HTTPS URL Slack can fetch (no auth). Recommended 1600×400 PNG.
  SLACK_HOME_HERO_URL:         optStr,
  KORTIX_DASHBOARD_URL:        optStr,

  // ── LLM Providers (optional — only needed in cloud mode) ─────────────────
  OPENROUTER_API_URL:          optUrl('https://openrouter.ai/api/v1'),
  OPENROUTER_API_KEY:          optStr,
  ANTHROPIC_API_URL:           optUrl('https://api.anthropic.com/v1'),
  ANTHROPIC_API_KEY:           optStr,
  OPENAI_API_URL:              optUrl('https://api.openai.com/v1'),
  OPENAI_API_KEY:              optStr,
  // xAI / Gemini / Groq route through OpenRouter (see router/config/proxy-services.ts),
  // so only their base URLs are read — no per-provider API keys.
  XAI_API_URL:                 optUrl('https://api.x.ai/v1'),
  GEMINI_API_URL:              optUrl('https://generativelanguage.googleapis.com/v1beta'),
  GROQ_API_URL:                optUrl('https://api.groq.com/openai/v1'),
  // ── Billing — Stripe (optional, only for cloud billing) ──────────────────
  STRIPE_SECRET_KEY:           optStr,
  STRIPE_WEBHOOK_SECRET:       optStr,

  // ── Billing — RevenueCat (optional) ──────────────────────────────────────
  REVENUECAT_WEBHOOK_SECRET:   optStr,

  // ── Daytona — Sandbox provisioning (conditional: required if daytona provider enabled) ──
  // Note: there is intentionally no DAYTONA_SNAPSHOT here. Every sandbox
  // boots from a per-project snapshot built by the snapshot builder
  // (apps/api/src/snapshots/builder.ts). A shared/global fallback image
  // would silently bypass per-project Dockerfiles and is explicitly
  // disallowed.
  DAYTONA_API_KEY:             optStr,
  DAYTONA_SERVER_URL:          optStr,
  DAYTONA_TARGET:              optStr,

  // ── Sandbox Platform ──────────────────────────────────────────────────────
  // Public API base URL, without a route suffix. Auto-derived from PORT in local mode.
  KORTIX_URL:                  optStr,
  KORTIX_YOLO_URL:             optUrl('https://api-yolo.kortix.com/v1'),
  ALLOWED_SANDBOX_PROVIDERS:   optStrDefault('daytona'),
  SANDBOX_IMAGE:               optStr,
  KORTIX_LOCAL_IMAGES:         optBoolFalse,
  DOCKER_HOST:                 optStr,
  SANDBOX_NETWORK:             optStr,
  // Default port base for sandbox port mapping; kept for the queue drainer
  // and deployments router which still reference it.
  SANDBOX_PORT_BASE:           optInt(14000),
  SANDBOX_CONTAINER_NAME:      z.string().optional().transform(v => v || undefined).default('kortix-sandbox'),

  // ── Internal Service Key (auto-generated if missing — never fails) ───────
  INTERNAL_SERVICE_KEY:        optStr,

  // ── Frontend (optional) ──────────────────────────────────────────────────
  FRONTEND_URL:                optUrl('http://localhost:3000'),

  // ── Pipedream Connect (optional — powers the Executor's 1-click connectors) ─
  PIPEDREAM_CLIENT_ID:         optStr,
  PIPEDREAM_CLIENT_SECRET:     optStr,
  PIPEDREAM_PROJECT_ID:        optStr,
  PIPEDREAM_ENVIRONMENT:       optStrDefault('production'),
  PIPEDREAM_WEBHOOK_SECRET:    optStr,

  // ── Tunnel (optional, all have sane defaults) ────────────────────────────
  TUNNEL_SIGNING_SECRET:             optStr,
  TUNNEL_ENABLED:                    optBoolTrue,
  TUNNEL_HEARTBEAT_INTERVAL_MS:      optInt(30_000),
  TUNNEL_HEARTBEAT_MAX_MISSED:       optInt(3),
  TUNNEL_RPC_TIMEOUT_MS:             optInt(30_000),
  TUNNEL_RATE_LIMIT_RPC:             optInt(100),
  TUNNEL_RATE_LIMIT_PERM_REQUEST:    optInt(20),
  TUNNEL_RATE_LIMIT_WS_CONNECT:      optInt(5),
  TUNNEL_RATE_LIMIT_PERM_GRANT:      optInt(30),
  TUNNEL_MAX_WS_MESSAGE_SIZE:        optInt(5 * 1024 * 1024),

  // ── Abuse controls (optional, all have sane defaults) ────────────────────
  KORTIX_INVITE_ACCEPT_REQS_PER_MIN:      optInt(20),
  KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE:    optInt(60),
  KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID:    optInt(600),
  KORTIX_PROXY_REQS_PER_MIN:              optInt(600),
  KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT: optInt(3),
  KORTIX_TRIGGER_SCHEDULER_ENABLED:        optBoolTrue,
  KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS:    optInt(60_000),

  // ── Version / GitHub (optional) ───────────────────────────────────────────
  SANDBOX_VERSION:             optStr,  // dev override: skip npm registry lookup for latest version
  GITHUB_TOKEN:                optStr,  // optional: authenticated GitHub API calls for changelog

  // ── Mailtrap (optional — provisioning email notifications) ────────────────
  MAILTRAP_API_TOKEN:          optStr,
  MAILTRAP_FROM_EMAIL:         optStrDefault('noreply@kortix.com'),
  MAILTRAP_FROM_NAME:          optStrDefault('Kortix'),

  // ── Better Stack Observability (optional — graceful degradation) ────────
  BETTERSTACK_API_LOG_TOKEN:   optStr,  // Logtail source token for structured logs
  BETTERSTACK_API_LOG_HOST:    optStr,  // Logtail ingesting host (e.g. s1234.us-east-9.betterstackdata.com)
  BETTERSTACK_API_SENTRY_DSN:  optStr,  // Sentry DSN for error tracking (Better Stack compatible)

  // ── Stray env vars used directly in other files (centralized here) ───────
  CORS_ALLOWED_ORIGINS:        optStr,
  KORTIX_MASTER_URL:           optStr,
  OPENCODE_URL:                optStr,
  KORTIX_DATA_DIR:             optStr,
});

// ─── Validation + Conditional Checks ────────────────────────────────────────

type EnvIssue = { var: string; message: string; level: 'error' | 'warn' };

// Recognised provider names. Source-of-truth for what can legally appear in
// ALLOWED_SANDBOX_PROVIDERS — adding a new provider is a one-place change
// here plus a case in `getProvider()` in platform/providers/index.ts.
const KNOWN_PROVIDERS: readonly SandboxProviderName[] = ['daytona', 'local_docker'] as const;

/** Parse comma-separated provider list (e.g. "daytona,local_docker"). */
function parseAllowedProviders(raw: string): SandboxProviderName[] {
  if (!raw) return ['daytona'];
  const names = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const valid: SandboxProviderName[] = [];
  for (const n of names) {
    if ((KNOWN_PROVIDERS as readonly string[]).includes(n)) {
      const known = n as SandboxProviderName;
      if (!valid.includes(known)) valid.push(known);
    } else {
      console.warn(`[config] Unknown sandbox provider "${n}" in ALLOWED_SANDBOX_PROVIDERS - ignored`);
    }
  }
  return valid.length > 0 ? valid : ['daytona'];
}

function validateEnv(): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(process.env);

  const issues: EnvIssue[] = [];

  // ── Collect Zod schema errors ──────────────────────────────────────────
  if (!result.success) {
    for (const issue of result.error.issues) {
      const varName = issue.path.join('.');
      issues.push({ var: varName, message: issue.message, level: 'error' });
    }
  }

  // Use raw values for conditional checks (schema may have failed)
  const raw = result.success ? result.data : (process.env as Record<string, string | undefined>);

  // ── Conditional: Daytona provider enabled → need Daytona keys ──────────
  const providers = parseAllowedProviders((raw as any).ALLOWED_SANDBOX_PROVIDERS || '');
  if (providers.includes('daytona')) {
    if (!raw.DAYTONA_API_KEY)    issues.push({ var: 'DAYTONA_API_KEY',    message: 'Required when ALLOWED_SANDBOX_PROVIDERS includes "daytona"', level: 'error' });
    if (!raw.DAYTONA_SERVER_URL) issues.push({ var: 'DAYTONA_SERVER_URL', message: 'Required when ALLOWED_SANDBOX_PROVIDERS includes "daytona"', level: 'error' });
    if (!raw.DAYTONA_TARGET)     issues.push({ var: 'DAYTONA_TARGET',     message: 'Required when ALLOWED_SANDBOX_PROVIDERS includes "daytona"', level: 'error' });
  }
  if (providers.includes('local_docker') && !raw.DOCKER_HOST) {
    issues.push({ var: 'DOCKER_HOST', message: 'Required when ALLOWED_SANDBOX_PROVIDERS includes "local_docker"', level: 'error' });
  }

  // ── Conditional: Billing enabled → need Stripe keys ────────────────────
  const billingWillBeEnabled = (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === 'true' || (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === true;
  if (billingWillBeEnabled) {
    if (!raw.STRIPE_SECRET_KEY)    issues.push({ var: 'STRIPE_SECRET_KEY',    message: 'Required when KORTIX_BILLING_INTERNAL_ENABLED=true', level: 'error' });
    if (!raw.STRIPE_WEBHOOK_SECRET) issues.push({ var: 'STRIPE_WEBHOOK_SECRET', message: 'Required when KORTIX_BILLING_INTERNAL_ENABLED=true', level: 'error' });
  }

  // ── Conditional: Tunnel enabled → need signing secret ──────────────────
  const tunnelEnabled = (raw as any).TUNNEL_ENABLED !== 'false' && (raw as any).TUNNEL_ENABLED !== false;
  if (tunnelEnabled && !raw.TUNNEL_SIGNING_SECRET) {
    issues.push({ var: 'TUNNEL_SIGNING_SECRET', message: 'Required when tunnel is enabled — used for HMAC signing key derivation', level: 'error' });
  }

  // ── Conditional: KORTIX_URL — required for sandbox routing ──────────────
  // Auto-derive from PORT for self-host/dev — fatal when billing is enabled
  // (you can't bill against an unreachable origin).
  if (!raw.KORTIX_URL) {
    const port = (raw as any).PORT || '8008';
    if (billingWillBeEnabled) {
      issues.push({ var: 'KORTIX_URL', message: 'Required when KORTIX_BILLING_INTERNAL_ENABLED=true — sandbox routing and health checks will break', level: 'error' });
    } else {
      // Auto-derive so dev/self-host "just works". KORTIX_URL is the public
      // API origin/base; individual callers append /v1, /v1/router, etc.
      const derived = `http://localhost:${port}`;
      process.env.KORTIX_URL = derived;
      if (result.success) (result.data as any).KORTIX_URL = derived;
      console.warn(`[config] KORTIX_URL not set — auto-derived: ${derived}`);
      issues.push({ var: 'KORTIX_URL', message: `Not set — auto-derived to ${derived} (add to .env to silence this)`, level: 'warn' });
    }
  }

  // ── Warnings (non-fatal but worth knowing) ─────────────────────────────
  if (!raw.OPENROUTER_API_KEY) {
    issues.push({ var: 'OPENROUTER_API_KEY', message: 'Not set — primary LLM route will fail with silent 401 errors', level: 'warn' });
  }

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
    console.error('\x1b[31m  kortix-api: Environment validation FAILED — server cannot start\x1b[0m');
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

  console.log(`[config] Environment validated (${Object.keys(envSchema.shape).length} vars, ${warnings.length} warnings)`);
  return result.data;
}

// ─── Run Validation at Module Load ──────────────────────────────────────────

const env = validateEnv();

// ─── Parse Providers ────────────────────────────────────────────────────────

const allowedProviders = parseAllowedProviders(env.ALLOWED_SANDBOX_PROVIDERS);

// ─── Config Object (typed, validated) ───────────────────────────────────────

export const config = {
  PORT: env.PORT,

  // ─── Internal Deployment Controls ─────────────────────────────────────────
  INTERNAL_KORTIX_ENV: env.INTERNAL_KORTIX_ENV as InternalKortixEnv,
  // Single master switch — see schema docstring above.
  KORTIX_BILLING_INTERNAL_ENABLED: env.KORTIX_BILLING_INTERNAL_ENABLED,
  KORTIX_DEPLOYMENTS_ENABLED: env.KORTIX_DEPLOYMENTS_ENABLED,
  KORTIX_APPS_EXPERIMENTAL: env.KORTIX_APPS_EXPERIMENTAL,

  // ─── Database ──────────────────────────────────────────────────────────────
  DATABASE_URL: env.DATABASE_URL,

  // ─── Supabase ──────────────────────────────────────────────────────────────
  SUPABASE_URL: env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,

  // ─── API Key Hashing ──────────────────────────────────────────────────────
  API_KEY_SECRET: env.API_KEY_SECRET,

  // ─── Pipedream Connect (Executor 1-click connectors) ──────────────────────
  PIPEDREAM_CLIENT_ID: env.PIPEDREAM_CLIENT_ID,
  PIPEDREAM_CLIENT_SECRET: env.PIPEDREAM_CLIENT_SECRET,
  PIPEDREAM_PROJECT_ID: env.PIPEDREAM_PROJECT_ID,
  PIPEDREAM_ENVIRONMENT: env.PIPEDREAM_ENVIRONMENT,
  PIPEDREAM_WEBHOOK_SECRET: env.PIPEDREAM_WEBHOOK_SECRET,

  // ─── Search Providers ──────────────────────────────────────────────────────
  TAVILY_API_URL: env.TAVILY_API_URL,
  TAVILY_API_KEY: env.TAVILY_API_KEY,
  SERPER_API_URL: env.SERPER_API_URL,
  SERPER_API_KEY: env.SERPER_API_KEY,

  // ─── Proxy Providers ──────────────────────────────────────────────────────
  FIRECRAWL_API_URL: env.FIRECRAWL_API_URL,
  FIRECRAWL_API_KEY: env.FIRECRAWL_API_KEY,
  REPLICATE_API_URL: env.REPLICATE_API_URL,
  REPLICATE_API_TOKEN: env.REPLICATE_API_TOKEN,
  CONTEXT7_API_URL: env.CONTEXT7_API_URL,
  CONTEXT7_API_KEY: env.CONTEXT7_API_KEY,

  // ─── Freestyle (Deployments) ──────────────────────────────────────────────
  FREESTYLE_API_URL: env.FREESTYLE_API_URL,
  FREESTYLE_API_KEY: env.FREESTYLE_API_KEY,

  // ─── Managed git ──────────────────────────────────────────────────────────
  MANAGED_GIT_PROVIDER: env.MANAGED_GIT_PROVIDER,
  MANAGED_GIT_GITHUB_OWNER: env.MANAGED_GIT_GITHUB_OWNER,
  MANAGED_GIT_GITHUB_INSTALL_ID: env.MANAGED_GIT_GITHUB_INSTALL_ID,
  MANAGED_GIT_GITHUB_TOKEN: env.MANAGED_GIT_GITHUB_TOKEN,
  KORTIX_GIT_PROXY: env.KORTIX_GIT_PROXY,
  KORTIX_WARM_POOL_ENABLED: env.KORTIX_WARM_POOL_ENABLED,
  KORTIX_WARM_POOL_MAX_TOTAL: env.KORTIX_WARM_POOL_MAX_TOTAL,
  KORTIX_WARM_POOL_ACTIVE_DAYS: env.KORTIX_WARM_POOL_ACTIVE_DAYS,

  // ─── Legacy migration ─────────────────────────────────────────────────────
  JUSTAVPS_PROXY_DOMAIN: env.JUSTAVPS_PROXY_DOMAIN,
  JUSTAVPS_API_URL: env.JUSTAVPS_API_URL,
  JUSTAVPS_API_KEY: env.JUSTAVPS_API_KEY,
  LEGACY_MIGRATION_BACKUP_BUCKET: env.LEGACY_MIGRATION_BACKUP_BUCKET,

  // ─── Channels (Slack) ─────────────────────────────────────────────────────
  SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET,
  SLACK_TEAM_ID: env.SLACK_TEAM_ID,
  SLACK_CLIENT_ID: env.SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET: env.SLACK_CLIENT_SECRET,
  SLACK_REDIRECT_URI: env.SLACK_REDIRECT_URI,
  SLACK_OAUTH_SCOPES: env.SLACK_OAUTH_SCOPES,
  SLACK_HOME_HERO_URL: env.SLACK_HOME_HERO_URL,
  KORTIX_DASHBOARD_URL: env.KORTIX_DASHBOARD_URL,

  // ─── LLM Providers ────────────────────────────────────────────────────────
  OPENROUTER_API_URL: env.OPENROUTER_API_URL,
  OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
  ANTHROPIC_API_URL: env.ANTHROPIC_API_URL,
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  OPENAI_API_URL: env.OPENAI_API_URL,
  OPENAI_API_KEY: env.OPENAI_API_KEY,
  XAI_API_URL: env.XAI_API_URL,
  GEMINI_API_URL: env.GEMINI_API_URL,
  GROQ_API_URL: env.GROQ_API_URL,
  // ─── Stripe (Billing) ─────────────────────────────────────────────────────
  STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET,

  // ─── RevenueCat (Billing) ─────────────────────────────────────────────────
  REVENUECAT_WEBHOOK_SECRET: env.REVENUECAT_WEBHOOK_SECRET,

  // ─── Daytona (Sandbox provisioning + preview proxy) ───────────────────────
  // No DAYTONA_SNAPSHOT here — see comment in the env schema above. Every
  // sandbox boots from its project-specific snapshot resolved at session
  // start time by apps/api/src/snapshots/builder.ts.
  DAYTONA_API_KEY: env.DAYTONA_API_KEY,
  DAYTONA_SERVER_URL: env.DAYTONA_SERVER_URL,
  DAYTONA_TARGET: env.DAYTONA_TARGET,

  // ─── Sandbox Provisioning (Platform) ──────────────────────────────────────
  KORTIX_URL: env.KORTIX_URL,
  KORTIX_YOLO_URL: env.KORTIX_YOLO_URL,
  ALLOWED_SANDBOX_PROVIDERS: allowedProviders,
  SANDBOX_IMAGE: env.SANDBOX_IMAGE || 'kortix/kortix-sandbox:latest',
  KORTIX_LOCAL_IMAGES: env.KORTIX_LOCAL_IMAGES,
  DOCKER_HOST: env.DOCKER_HOST,
  SANDBOX_NETWORK: env.SANDBOX_NETWORK,
  SANDBOX_PORT_BASE: env.SANDBOX_PORT_BASE,
  SANDBOX_CONTAINER_NAME: env.SANDBOX_CONTAINER_NAME,

  /**
   * INTERNAL_SERVICE_KEY -- direction: kortix-api -> sandbox.
   *
   * This is how kortix-api authenticates itself TO the sandbox. Every request
   * from kortix-api to the sandbox (proxy, cron, health, queue drain, etc.)
   * includes `Authorization: Bearer <INTERNAL_SERVICE_KEY>`. The sandbox's
   * kortix-master middleware validates it.
   *
   * Counterpart: KORTIX_TOKEN goes the other direction (sandbox -> kortix-api).
   *
   * Auto-generated at startup if not provided -- always present.
   * Persisted to .env so the same key survives process restarts.
   */
  get INTERNAL_SERVICE_KEY(): string {
    if (!process.env.INTERNAL_SERVICE_KEY) {
      const { randomBytes } = require('crypto');
      const generated = randomBytes(32).toString('hex');
      process.env.INTERNAL_SERVICE_KEY = generated;
      console.log('[config] Auto-generated INTERNAL_SERVICE_KEY for sandbox auth');
      // Persist to .env so the key survives process restarts (avoids re-sync on every restart)
      try {
        const { appendFileSync, readFileSync, existsSync } = require('fs');
        const { resolve } = require('path');
        const candidates = [
          resolve(__dirname, '../../.env'),       // from src/config.ts -> ../../.env
          resolve(process.cwd(), '.env'),          // cwd/.env
        ];
        for (const envPath of candidates) {
          if (existsSync(envPath)) {
            const content = readFileSync(envPath, 'utf-8');
            if (!content.includes('INTERNAL_SERVICE_KEY=')) {
              appendFileSync(envPath, `\n# Auto-generated service key for sandbox auth (do not remove)\nINTERNAL_SERVICE_KEY=${generated}\n`);
              console.log(`[config] Persisted INTERNAL_SERVICE_KEY to ${envPath}`);
            }
            break;
          }
        }
      } catch (err: any) {
        // Non-fatal -- key still works in-memory for this process lifetime
        console.warn('[config] Could not persist INTERNAL_SERVICE_KEY to .env:', err.message);
      }
    }
    return process.env.INTERNAL_SERVICE_KEY!;
  },

  // ─── Frontend ────────────────────────────────────────────────────────────
  FRONTEND_URL: env.FRONTEND_URL,

  // ─── Tunnel (Reverse-Tunnel to Local Machine) ──────────────────────────────
  TUNNEL_SIGNING_SECRET: env.TUNNEL_SIGNING_SECRET,
  TUNNEL_ENABLED: env.TUNNEL_ENABLED,
  TUNNEL_HEARTBEAT_INTERVAL_MS: env.TUNNEL_HEARTBEAT_INTERVAL_MS,
  TUNNEL_HEARTBEAT_MAX_MISSED: env.TUNNEL_HEARTBEAT_MAX_MISSED,
  TUNNEL_RPC_TIMEOUT_MS: env.TUNNEL_RPC_TIMEOUT_MS,
  TUNNEL_RATE_LIMIT_RPC: env.TUNNEL_RATE_LIMIT_RPC,
  TUNNEL_RATE_LIMIT_PERM_REQUEST: env.TUNNEL_RATE_LIMIT_PERM_REQUEST,
  TUNNEL_RATE_LIMIT_WS_CONNECT: env.TUNNEL_RATE_LIMIT_WS_CONNECT,
  TUNNEL_RATE_LIMIT_PERM_GRANT: env.TUNNEL_RATE_LIMIT_PERM_GRANT,
  TUNNEL_MAX_WS_MESSAGE_SIZE: env.TUNNEL_MAX_WS_MESSAGE_SIZE,

  // ─── Abuse Controls ───────────────────────────────────────────────────────
  KORTIX_INVITE_ACCEPT_REQS_PER_MIN: env.KORTIX_INVITE_ACCEPT_REQS_PER_MIN,
  KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE: env.KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE,
  KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID: env.KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID,
  KORTIX_PROXY_REQS_PER_MIN: env.KORTIX_PROXY_REQS_PER_MIN,
  KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT: env.KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT,
  KORTIX_TRIGGER_SCHEDULER_ENABLED: env.KORTIX_TRIGGER_SCHEDULER_ENABLED,
  KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS: env.KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS,

  // ─── Version / GitHub ──────────────────────────────────────────────────────
  /** Dev override: force a specific sandbox version via env var. */
  SANDBOX_VERSION_OVERRIDE: env.SANDBOX_VERSION,
  GITHUB_TOKEN: env.GITHUB_TOKEN,

  // ─── Mailtrap (Email Notifications) ────────────────────────────────────────
  MAILTRAP_API_TOKEN: env.MAILTRAP_API_TOKEN,
  MAILTRAP_FROM_EMAIL: env.MAILTRAP_FROM_EMAIL,
  MAILTRAP_FROM_NAME: env.MAILTRAP_FROM_NAME,

  // ─── Stray env vars (centralized from other files) ────────────────────────
  CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS,
  KORTIX_MASTER_URL: env.KORTIX_MASTER_URL,
  OPENCODE_URL: env.OPENCODE_URL,
  KORTIX_DATA_DIR: env.KORTIX_DATA_DIR,

  // ─── Helper Methods ────────────────────────────────────────────────────────

  isProviderEnabled(name: SandboxProviderName): boolean {
    if (!this.ALLOWED_SANDBOX_PROVIDERS.includes(name)) return false;
    switch (name) {
      case 'daytona': return !!this.DAYTONA_API_KEY;
      case 'local_docker': return !!this.DOCKER_HOST;
      default: {
        const exhaustive: never = name;
        return exhaustive;
      }
    }
  },

  /**
   * Default sandbox provider for new sessions. First entry of
   * ALLOWED_SANDBOX_PROVIDERS, with 'daytona' as the safety belt for an
   * empty list. The single-provider invariant means there's no resolution
   * order today, but the function is the contract callers depend on —
   * adding a new provider later just changes what the list can contain.
   */
  getDefaultProvider(): SandboxProviderName {
    return this.ALLOWED_SANDBOX_PROVIDERS[0] ?? 'daytona';
  },

  isDaytonaEnabled(): boolean {
    return this.ALLOWED_SANDBOX_PROVIDERS.includes('daytona') && !!this.DAYTONA_API_KEY;
  },

  isLocalDockerEnabled(): boolean {
    return this.ALLOWED_SANDBOX_PROVIDERS.includes('local_docker') && !!this.DOCKER_HOST;
  },

};

// ─── Billing Markup Constants ────────────────────────────────────────────────
//
// Two pricing modes based on whose API key is used:
//   * Kortix keys (user uses our keys):  1.2x provider cost (20% markup)
//   * User's own keys (passthrough):     0.1x provider cost (10% platform fee)

/** Markup when Kortix provides the API key. */
export const KORTIX_MARKUP = 1.2;

/** Platform fee when user provides their own API key. */
export const PLATFORM_FEE_MARKUP = 0.1;

// ─── Tool Pricing (Router) ──────────────────────────────────────────────────

interface ToolPricing {
  baseCost: number;
  perResultCost: number;
  markupMultiplier: number;
}

const TOOL_PRICING: Record<string, ToolPricing> = {
  web_search_basic: {
    baseCost: 0.005,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  web_search_advanced: {
    baseCost: 0.025,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  image_search: {
    baseCost: 0.001,
    perResultCost: 0,
    markupMultiplier: 2.0,
  },
  proxy_tavily: {
    baseCost: 0.005,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  proxy_serper: {
    baseCost: 0.001,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  proxy_firecrawl: {
    baseCost: 0.01,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  proxy_replicate: {
    baseCost: 0.005,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  proxy_replicate_nano_banana: {
    baseCost: 0.01,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  proxy_replicate_gpt_image: {
    baseCost: 0.05,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  // Moondream2 vision captioning (image_search enrichment) — cheap per-call model.
  proxy_replicate_moondream: {
    baseCost: 0.002,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  // Polling a created prediction's status — billed at zero (the create call already paid).
  proxy_replicate_poll: {
    baseCost: 0,
    perResultCost: 0,
    markupMultiplier: 1,
  },
  proxy_context7: {
    baseCost: 0.001,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
  proxy_freestyle_deploy: {
    baseCost: 0.01,
    perResultCost: 0,
    markupMultiplier: 1.5,
  },
};

export function getToolCost(toolName: string, resultCount: number = 0): number {
  const pricing = TOOL_PRICING[toolName];
  if (!pricing) {
    return 0.01;
  }

  const base = pricing.baseCost * pricing.markupMultiplier;
  const perResult = pricing.perResultCost * pricing.markupMultiplier * resultCount;
  return base + perResult;
}
