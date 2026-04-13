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

export type SandboxProviderName = 'daytona' | 'local_docker' | 'justavps';
export type InternalKortixEnv = 'dev' | 'staging' | 'prod';

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

/** Optional float with a default. */
const optFloat = (def: number) =>
  z.string().optional().default(String(def)).transform((v) => {
    const n = parseFloat(v);
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
  ENV_MODE:                    z.enum(['local', 'cloud']).optional().default('local'),

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
  KORTIX_BILLING_INTERNAL_ENABLED:  optBoolFalse,  // NOTE: overridden by ENV_MODE=cloud below
  KORTIX_DEPLOYMENTS_ENABLED:       optBoolFalse,

  // ── CRW (search, scrape, crawl, map — replaces Tavily, Serper, Firecrawl) ─
  CRW_API_URL:                 optUrl('https://fastcrw.com/api'),
  CRW_API_KEY:                 optStr,

  // ── Legacy Search Providers (kept for backward compat, optional) ────────
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

  // ── LLM Providers (optional — only needed in cloud mode) ─────────────────
  OPENROUTER_API_URL:          optUrl('https://openrouter.ai/api/v1'),
  OPENROUTER_API_KEY:          optStr,
  ANTHROPIC_API_URL:           optUrl('https://api.anthropic.com/v1'),
  ANTHROPIC_API_KEY:           optStr,
  OPENAI_API_URL:              optUrl('https://api.openai.com/v1'),
  OPENAI_API_KEY:              optStr,
  XAI_API_URL:                 optUrl('https://api.x.ai/v1'),
  XAI_API_KEY:                 optStr,
  GEMINI_API_URL:              optUrl('https://generativelanguage.googleapis.com/v1beta'),
  GEMINI_API_KEY:              optStr,
  GROQ_API_URL:                optUrl('https://api.groq.com/openai/v1'),
  GROQ_API_KEY:                optStr,
  // ── Billing — Stripe (optional, only for cloud billing) ──────────────────
  STRIPE_SECRET_KEY:           optStr,
  STRIPE_WEBHOOK_SECRET:       optStr,

  // ── Billing — RevenueCat (optional) ──────────────────────────────────────
  REVENUECAT_WEBHOOK_SECRET:   optStr,

  // ── Daytona — Sandbox provisioning (conditional: required if daytona provider enabled) ──
  DAYTONA_API_KEY:             optStr,
  DAYTONA_SERVER_URL:          optStr,
  DAYTONA_TARGET:              optStr,
  DAYTONA_SNAPSHOT:            optStr,

  // ── JustAVPS — Sandbox provisioning via JustAVPS API (conditional: required if justavps provider enabled) ──
  JUSTAVPS_API_URL:                   optStrDefault('http://localhost:3001'),
  JUSTAVPS_API_KEY:                   optStr,
  JUSTAVPS_IMAGE_ID:                  optStr,   // Optional pin — if unset, auto-resolves latest kortix-computer-v* image from JustAVPS
  JUSTAVPS_DEFAULT_LOCATION:          optStrDefault('hel1'),
  JUSTAVPS_DEFAULT_SERVER_TYPE:       optStrDefault('pro'),
  JUSTAVPS_PROXY_DOMAIN:              optStrDefault('kortix.cloud'),  // CF Worker proxy domain ({slug}.kortix.cloud)
  JUSTAVPS_WEBHOOK_SECRET:            optStr,   // HMAC secret for verifying JustAVPS webhook signatures
  JUSTAVPS_WEBHOOK_URL:               optStr,   // URL where JustAVPS should send webhook events (e.g. https://api.kortix.com/v1/platform/webhooks/justavps)

  // ── Sandbox Pool (optional — pre-provision sandboxes for instant claiming) ──
  POOL_ENABLED:                optBoolFalse,
  POOL_MAX_AGE_HOURS:          optInt(24),

  // ── Sandbox Platform ──────────────────────────────────────────────────────
  // KORTIX_URL is auto-derived from PORT if not explicitly set (see validateEnv).
  KORTIX_URL:                  optStr,
  ALLOWED_SANDBOX_PROVIDERS:   optStrDefault('local_docker'),
  SANDBOX_IMAGE:               optStr,  // overridden below if empty
  KORTIX_LOCAL_IMAGES:         optBoolFalse,
  DOCKER_HOST:                 optStr,
  SANDBOX_NETWORK:             optStr,
  SANDBOX_PORT_BASE:           optInt(14000),
  // Container name for the local Docker sandbox — configurable so dev and
  // self-hosted instances can coexist on the same Docker daemon.
  // Empty string treated as unset so env_file with missing key is safe.
  SANDBOX_CONTAINER_NAME:      z.string().optional().transform(v => v || undefined).default('kortix-sandbox'),

  // ── Internal Service Key (auto-generated if missing — never fails) ───────
  INTERNAL_SERVICE_KEY:        optStr,

  // ── Frontend (optional) ──────────────────────────────────────────────────
  FRONTEND_URL:                optUrl('http://localhost:3000'),

  // ── Integrations / Pipedream (optional: only validated if explicitly set to "pipedream") ──
  INTEGRATION_AUTH_PROVIDER:   optStr,
  PIPEDREAM_CLIENT_ID:         optStr,
  PIPEDREAM_CLIENT_SECRET:     optStr,
  PIPEDREAM_PROJECT_ID:        optStr,
  PIPEDREAM_ENVIRONMENT:       optStrDefault('development'),
  PIPEDREAM_WEBHOOK_SECRET:    optStr,

  // ── Tunnel (optional, all have sane defaults) ────────────────────────────
  TUNNEL_SIGNING_SECRET:             optStr,
  TUNNEL_ENABLED:                    optBoolTrue,
  TUNNEL_HEARTBEAT_INTERVAL_MS:      optInt(30_000),
  TUNNEL_HEARTBEAT_MAX_MISSED:       optInt(3),
  TUNNEL_RPC_TIMEOUT_MS:             optInt(30_000),
  TUNNEL_MAX_FILE_SIZE:              optInt(10 * 1024 * 1024),
  TUNNEL_PERMISSION_REQUEST_TTL_MS:  optInt(300_000),
  TUNNEL_RATE_LIMIT_RPC:             optInt(100),
  TUNNEL_RATE_LIMIT_PERM_REQUEST:    optInt(20),
  TUNNEL_RATE_LIMIT_WS_CONNECT:      optInt(5),
  TUNNEL_RATE_LIMIT_PERM_GRANT:      optInt(30),
  TUNNEL_MAX_WS_MESSAGE_SIZE:        optInt(5 * 1024 * 1024),

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

/** Parse comma-separated provider list (e.g. "daytona,local_docker") */
function parseAllowedProviders(raw: string): SandboxProviderName[] {
  if (!raw) return ['local_docker'];
  const names = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const valid: SandboxProviderName[] = [];
  for (const n of names) {
    if (n === 'daytona' || n === 'local_docker' || n === 'justavps') {
      if (!valid.includes(n)) valid.push(n);
    } else {
      console.warn(`[config] Unknown sandbox provider "${n}" in ALLOWED_SANDBOX_PROVIDERS - ignored`);
    }
  }
  return valid.length > 0 ? valid : ['local_docker'];
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

  // ── Conditional: local_docker → need DOCKER_HOST ───────────────────────
  if (providers.includes('local_docker')) {
    if (!raw.DOCKER_HOST) issues.push({ var: 'DOCKER_HOST', message: 'Required when ALLOWED_SANDBOX_PROVIDERS includes "local_docker"', level: 'error' });
  }

  // ── Conditional: justavps → need JustAVPS keys ────────────────────────
  if (providers.includes('justavps')) {
    if (!raw.JUSTAVPS_API_KEY) issues.push({ var: 'JUSTAVPS_API_KEY', message: 'Required when ALLOWED_SANDBOX_PROVIDERS includes "justavps"', level: 'error' });
    // JUSTAVPS_IMAGE_ID is optional — if unset, the provider auto-resolves the latest kortix-computer-v* image at runtime.
  }

  // ── Conditional: Pipedream integration → warn if credentials missing ────
  // Not fatal — requests can provide their own creds via X-Pipedream-* headers.
  const integrationProvider = (raw as any).INTEGRATION_AUTH_PROVIDER || 'pipedream';
  if (integrationProvider === 'pipedream') {
    if (!raw.PIPEDREAM_CLIENT_ID)     issues.push({ var: 'PIPEDREAM_CLIENT_ID',     message: 'Pipedream integrations will only work via request headers (X-Pipedream-Client-Id)', level: 'warn' });
    if (!raw.PIPEDREAM_CLIENT_SECRET) issues.push({ var: 'PIPEDREAM_CLIENT_SECRET', message: 'Pipedream integrations will only work via request headers (X-Pipedream-Client-Secret)', level: 'warn' });
    if (!raw.PIPEDREAM_PROJECT_ID)    issues.push({ var: 'PIPEDREAM_PROJECT_ID',    message: 'Pipedream integrations will only work via request headers (X-Pipedream-Project-Id)', level: 'warn' });
  }

  // ── Conditional: Billing enabled → need Stripe keys ────────────────────
  const billingWillBeEnabled = (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === 'true' || (raw as any).KORTIX_BILLING_INTERNAL_ENABLED === true || (raw as any).ENV_MODE === 'cloud';
  if (billingWillBeEnabled) {
    if (!raw.STRIPE_SECRET_KEY)    issues.push({ var: 'STRIPE_SECRET_KEY',    message: 'Required when billing is enabled (ENV_MODE=cloud)', level: 'error' });
    if (!raw.STRIPE_WEBHOOK_SECRET) issues.push({ var: 'STRIPE_WEBHOOK_SECRET', message: 'Required when billing is enabled (ENV_MODE=cloud)', level: 'error' });
  }

  // ── Conditional: Tunnel enabled → need signing secret ──────────────────
  const tunnelEnabled = (raw as any).TUNNEL_ENABLED !== 'false' && (raw as any).TUNNEL_ENABLED !== false;
  if (tunnelEnabled && !raw.TUNNEL_SIGNING_SECRET) {
    issues.push({ var: 'TUNNEL_SIGNING_SECRET', message: 'Required when tunnel is enabled — used for HMAC signing key derivation', level: 'error' });
  }

  // ── Conditional: KORTIX_URL — required for sandbox routing ──────────────
  // Used by every sandbox provider (local_docker, daytona, justavps),
  // channels webhook URL generation, pool env injection, and sandbox health.
  // Auto-derive from PORT in local mode if not set — fatal in cloud mode.
  if (!raw.KORTIX_URL) {
    const envMode = (raw as any).ENV_MODE || 'local';
    const port = (raw as any).PORT || '8008';
    if (envMode === 'cloud') {
      issues.push({ var: 'KORTIX_URL', message: 'Required in cloud mode — sandbox routing, channels webhooks, and health checks will break', level: 'error' });
    } else {
      // Auto-derive for local mode so it "just works"
      const derived = `http://localhost:${port}/v1/router`;
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
  ENV_MODE: env.ENV_MODE,

  // ─── Internal Deployment Controls ─────────────────────────────────────────
  INTERNAL_KORTIX_ENV: env.INTERNAL_KORTIX_ENV as InternalKortixEnv,
  // Billing is enabled when ENV_MODE is 'cloud' — no separate env var needed.
  KORTIX_BILLING_INTERNAL_ENABLED: env.KORTIX_BILLING_INTERNAL_ENABLED || env.ENV_MODE === 'cloud',
  KORTIX_DEPLOYMENTS_ENABLED: env.KORTIX_DEPLOYMENTS_ENABLED,

  // ─── Database ──────────────────────────────────────────────────────────────
  DATABASE_URL: env.DATABASE_URL,

  // ─── Supabase ──────────────────────────────────────────────────────────────
  SUPABASE_URL: env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,

  // ─── API Key Hashing ──────────────────────────────────────────────────────
  API_KEY_SECRET: env.API_KEY_SECRET,

  // ─── CRW (unified search, scrape, crawl) ───────────────────────────────────
  CRW_API_URL: env.CRW_API_URL,
  CRW_API_KEY: env.CRW_API_KEY,

  // ─── Legacy Search Providers ──────────────────────────────────────────────
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

  // ─── LLM Providers ────────────────────────────────────────────────────────
  OPENROUTER_API_URL: env.OPENROUTER_API_URL,
  OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
  ANTHROPIC_API_URL: env.ANTHROPIC_API_URL,
  ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
  OPENAI_API_URL: env.OPENAI_API_URL,
  OPENAI_API_KEY: env.OPENAI_API_KEY,
  XAI_API_URL: env.XAI_API_URL,
  XAI_API_KEY: env.XAI_API_KEY,
  GEMINI_API_URL: env.GEMINI_API_URL,
  GEMINI_API_KEY: env.GEMINI_API_KEY,
  GROQ_API_URL: env.GROQ_API_URL,
  GROQ_API_KEY: env.GROQ_API_KEY,
  // ─── Stripe (Billing) ─────────────────────────────────────────────────────
  STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET,

  // ─── RevenueCat (Billing) ─────────────────────────────────────────────────
  REVENUECAT_WEBHOOK_SECRET: env.REVENUECAT_WEBHOOK_SECRET,

  // ─── Daytona (Sandbox provisioning + preview proxy) ───────────────────────
  DAYTONA_API_KEY: env.DAYTONA_API_KEY,
  DAYTONA_SERVER_URL: env.DAYTONA_SERVER_URL,
  DAYTONA_TARGET: env.DAYTONA_TARGET,
  DAYTONA_SNAPSHOT: env.DAYTONA_SNAPSHOT || `kortix-sandbox-v${SANDBOX_VERSION}`,

  // ─── JustAVPS (VPS Sandbox provisioning via JustAVPS) ────────────────────
  JUSTAVPS_API_URL: env.JUSTAVPS_API_URL,
  JUSTAVPS_API_KEY: env.JUSTAVPS_API_KEY,
  JUSTAVPS_IMAGE_ID: env.JUSTAVPS_IMAGE_ID,
  JUSTAVPS_DEFAULT_LOCATION: env.JUSTAVPS_DEFAULT_LOCATION,
  JUSTAVPS_DEFAULT_SERVER_TYPE: env.JUSTAVPS_DEFAULT_SERVER_TYPE,
  JUSTAVPS_PROXY_DOMAIN: env.JUSTAVPS_PROXY_DOMAIN,
  JUSTAVPS_WEBHOOK_SECRET: env.JUSTAVPS_WEBHOOK_SECRET,
  JUSTAVPS_WEBHOOK_URL: env.JUSTAVPS_WEBHOOK_URL,

  // ─── Sandbox Pool ─────────────────────────────────────────────────────────
  POOL_ENABLED: env.POOL_ENABLED,
  POOL_MAX_AGE_HOURS: env.POOL_MAX_AGE_HOURS,

  // ─── Sandbox Provisioning (Platform) ──────────────────────────────────────
  KORTIX_URL: env.KORTIX_URL,
  ALLOWED_SANDBOX_PROVIDERS: allowedProviders,
  SANDBOX_IMAGE: env.SANDBOX_IMAGE || 'kortix/computer:latest',
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

  // ─── Integrations (OAuth Provider) ───────────────────────────────────────
  INTEGRATION_AUTH_PROVIDER: env.INTEGRATION_AUTH_PROVIDER,
  PIPEDREAM_CLIENT_ID: env.PIPEDREAM_CLIENT_ID,
  PIPEDREAM_CLIENT_SECRET: env.PIPEDREAM_CLIENT_SECRET,
  PIPEDREAM_PROJECT_ID: env.PIPEDREAM_PROJECT_ID,
  PIPEDREAM_ENVIRONMENT: env.PIPEDREAM_ENVIRONMENT,
  PIPEDREAM_WEBHOOK_SECRET: env.PIPEDREAM_WEBHOOK_SECRET,

  // ─── Tunnel (Reverse-Tunnel to Local Machine) ──────────────────────────────
  TUNNEL_SIGNING_SECRET: env.TUNNEL_SIGNING_SECRET,
  TUNNEL_ENABLED: env.TUNNEL_ENABLED,
  TUNNEL_HEARTBEAT_INTERVAL_MS: env.TUNNEL_HEARTBEAT_INTERVAL_MS,
  TUNNEL_HEARTBEAT_MAX_MISSED: env.TUNNEL_HEARTBEAT_MAX_MISSED,
  TUNNEL_RPC_TIMEOUT_MS: env.TUNNEL_RPC_TIMEOUT_MS,
  TUNNEL_MAX_FILE_SIZE: env.TUNNEL_MAX_FILE_SIZE,
  TUNNEL_PERMISSION_REQUEST_TTL_MS: env.TUNNEL_PERMISSION_REQUEST_TTL_MS,
  TUNNEL_RATE_LIMIT_RPC: env.TUNNEL_RATE_LIMIT_RPC,
  TUNNEL_RATE_LIMIT_PERM_REQUEST: env.TUNNEL_RATE_LIMIT_PERM_REQUEST,
  TUNNEL_RATE_LIMIT_WS_CONNECT: env.TUNNEL_RATE_LIMIT_WS_CONNECT,
  TUNNEL_RATE_LIMIT_PERM_GRANT: env.TUNNEL_RATE_LIMIT_PERM_GRANT,
  TUNNEL_MAX_WS_MESSAGE_SIZE: env.TUNNEL_MAX_WS_MESSAGE_SIZE,

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

  isLocal(): boolean {
    return this.ENV_MODE === 'local';
  },

  isCloud(): boolean {
    return !this.isLocal();
  },

  isDaytonaEnabled(): boolean {
    return this.ALLOWED_SANDBOX_PROVIDERS.includes('daytona') && !!this.DAYTONA_API_KEY;
  },

  isLocalDockerEnabled(): boolean {
    return this.ALLOWED_SANDBOX_PROVIDERS.includes('local_docker');
  },

  isJustAVPSEnabled(): boolean {
    return this.ALLOWED_SANDBOX_PROVIDERS.includes('justavps') && !!this.JUSTAVPS_API_KEY;
  },

  isPoolEnabled(): boolean {
    return this.POOL_ENABLED;
  },

  /** Default provider, preferring managed VPS in cloud mode when available. */
  getDefaultProvider(): SandboxProviderName {
    if (this.ENV_MODE === 'cloud' && this.ALLOWED_SANDBOX_PROVIDERS.includes('justavps')) {
      return 'justavps';
    }
    return this.ALLOWED_SANDBOX_PROVIDERS[0] ?? 'local_docker';
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

export interface ToolPricing {
  baseCost: number;
  perResultCost: number;
  markupMultiplier: number;
}

export const TOOL_PRICING: Record<string, ToolPricing> = {
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
  proxy_crw: {
    baseCost: 0.003,
    perResultCost: 0,
    markupMultiplier: 1.5,
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

// ─── LLM Pricing (Router) ───────────────────────────────────────────────────

export interface LLMPricing {
  inputCostPer1M: number;
  outputCostPer1M: number;
  markupMultiplier: number;
}

export const LLM_PRICING: Record<string, LLMPricing> = {
  openrouter: {
    inputCostPer1M: 0,
    outputCostPer1M: 0,
    markupMultiplier: 1.2,
  },
  anthropic: {
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
    markupMultiplier: 1.2,
  },
  openai: {
    inputCostPer1M: 2.5,
    outputCostPer1M: 10.0,
    markupMultiplier: 1.2,
  },
  xai: {
    inputCostPer1M: 2.0,
    outputCostPer1M: 10.0,
    markupMultiplier: 1.2,
  },
  groq: {
    inputCostPer1M: 0.05,
    outputCostPer1M: 0.08,
    markupMultiplier: 1.2,
  },
  gemini: {
    inputCostPer1M: 1.25,
    outputCostPer1M: 5.0,
    markupMultiplier: 1.2,
  },
};

export function calculateLLMCost(
  provider: string,
  inputTokens: number,
  outputTokens: number,
  providerReportedCost?: number
): number {
  const pricing = LLM_PRICING[provider] || LLM_PRICING['openrouter'];

  if (provider === 'openrouter' && providerReportedCost !== undefined) {
    return providerReportedCost * pricing.markupMultiplier;
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPer1M;
  return (inputCost + outputCost) * pricing.markupMultiplier;
}
