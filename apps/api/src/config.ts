import { allowedProviders, env } from './config/validate-env';
import type { InternalKortixEnv, SandboxProviderName } from './config/validate-env';

export { KNOWN_PROVIDERS, parseAllowedProviders } from './config/validate-env';
export { MORPH_MANAGED_MODELS_DEFAULT, parseMorphManagedModels } from './config/env-schema';
export { getToolCost, KORTIX_MARKUP } from './config/tool-pricing';
export type { SandboxProviderName } from './config/validate-env';

/**
 * Running sandbox version.
 *
 * Source of truth: SANDBOX_VERSION env var, injected at container start
 * by deploy-zero-downtime.sh (extracted from the Docker image tag).
 * Falls back to 'unknown' only if the env var is missing.
 */
export const SANDBOX_VERSION = process.env.SANDBOX_VERSION || 'unknown';

// ─── Config Object (typed, validated) ───────────────────────────────────────

export const config = {
  PORT: env.PORT,

  // ─── Internal Deployment Controls ─────────────────────────────────────────
  INTERNAL_KORTIX_ENV: env.INTERNAL_KORTIX_ENV as InternalKortixEnv,
  // Empty string reads as unset: the launchers always export the var, and a
  // blank value must not turn into an instance called "".
  KORTIX_INSTANCE_ID: env.KORTIX_INSTANCE_ID || undefined,
  KORTIX_PREVIEW_BASE_DOMAIN: env.KORTIX_PREVIEW_BASE_DOMAIN,
  // Single master switch — see schema docstring above.
  KORTIX_BILLING_INTERNAL_ENABLED: env.KORTIX_BILLING_INTERNAL_ENABLED,
  KORTIX_WORKERS_ENABLED: env.KORTIX_WORKERS_ENABLED,
  KORTIX_SANDBOX_EGRESS_PIN_ENFORCED: env.KORTIX_SANDBOX_EGRESS_PIN_ENFORCED,
  KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS: env.KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean),
  KORTIX_SECRET_RELAY_STREAM_ENABLED: env.KORTIX_SECRET_RELAY_STREAM_ENABLED,
  KORTIX_RELAY_WS_ENABLED: env.KORTIX_RELAY_WS_ENABLED,
  KORTIX_RELAY_MAX_REQUEST_BYTES: env.KORTIX_RELAY_MAX_REQUEST_BYTES,
  KORTIX_RELAY_MAX_RESPONSE_BYTES: env.KORTIX_RELAY_MAX_RESPONSE_BYTES,
  KORTIX_RELAY_HEADERS_TIMEOUT_MS: env.KORTIX_RELAY_HEADERS_TIMEOUT_MS,
  KORTIX_RELAY_UPSTREAM_IDLE_TIMEOUT_MS: env.KORTIX_RELAY_UPSTREAM_IDLE_TIMEOUT_MS,
  SESSION_TITLE_GENERATION_ENABLED: env.SESSION_TITLE_GENERATION_ENABLED,
  KORTIX_TEMPLATES_ENABLED: env.KORTIX_TEMPLATES_ENABLED,
  OPENAPI_PUBLIC_DOCS: env.OPENAPI_PUBLIC_DOCS,
  ENTERPRISE_LICENSE_AVAILABLE: env.ENTERPRISE_LICENSE_AVAILABLE,
  KORTIX_RESTRICT_ACCOUNT_CREATION: env.KORTIX_RESTRICT_ACCOUNT_CREATION,

  // ─── Database ──────────────────────────────────────────────────────────────
  DATABASE_URL: env.DATABASE_URL,

  // ─── Supabase ──────────────────────────────────────────────────────────────
  SUPABASE_URL: env.SUPABASE_URL,
  SUPABASE_PUBLIC_URL: env.SUPABASE_PUBLIC_URL,
  SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
  KORTIX_PUBLIC_AUTH_METHODS: env.KORTIX_PUBLIC_AUTH_METHODS,
  KORTIX_PUBLIC_AUTH_PROVIDERS: env.KORTIX_PUBLIC_AUTH_PROVIDERS,
  SUPABASE_JWT_SECRET: env.SUPABASE_JWT_SECRET,
  SUPABASE_JWT_LIVENESS_TTL_MS: env.SUPABASE_JWT_LIVENESS_TTL_MS,
  PROMPT_ATTACHMENT_UPLOAD_MODE: env.PROMPT_ATTACHMENT_UPLOAD_MODE,
  PROMPT_ATTACHMENT_CHUNK_BYTES: env.PROMPT_ATTACHMENT_CHUNK_BYTES,

  // ─── API Key Hashing ──────────────────────────────────────────────────────
  API_KEY_SECRET: env.API_KEY_SECRET,

  // ─── Pipedream Connect (Connector 1-click connectors) ──────────────────────
  PIPEDREAM_CLIENT_ID: env.PIPEDREAM_CLIENT_ID,
  PIPEDREAM_CLIENT_SECRET: env.PIPEDREAM_CLIENT_SECRET,
  PIPEDREAM_PROJECT_ID: env.PIPEDREAM_PROJECT_ID,
  PIPEDREAM_ENVIRONMENT: env.PIPEDREAM_ENVIRONMENT,
  PIPEDREAM_WEBHOOK_SECRET: env.PIPEDREAM_WEBHOOK_SECRET,

  // ─── Composio Connect (Connector connect provider) ─────────────────────────
  COMPOSIO_API_KEY: env.COMPOSIO_API_KEY,
  POSTMAN_API_KEY: env.POSTMAN_API_KEY,

  // ─── Search Providers ──────────────────────────────────────────────────────
  TAVILY_API_URL: env.TAVILY_API_URL,
  TAVILY_API_KEY: env.TAVILY_API_KEY,
  SERPER_API_URL: env.SERPER_API_URL,
  SERPER_API_KEY: env.SERPER_API_KEY,

  // ─── Proxy Providers ──────────────────────────────────────────────────────
  FIRECRAWL_API_URL: env.FIRECRAWL_API_URL,
  FIRECRAWL_API_KEY: env.FIRECRAWL_API_KEY,
  CONTEXT7_API_URL: env.CONTEXT7_API_URL,
  CONTEXT7_API_KEY: env.CONTEXT7_API_KEY,

  // ─── Managed git ──────────────────────────────────────────────────────────
  MANAGED_GIT_PROVIDER: env.MANAGED_GIT_PROVIDER,
  MANAGED_GIT_GITHUB_OWNER: env.MANAGED_GIT_GITHUB_OWNER,
  MANAGED_GIT_GITHUB_INSTALL_ID: env.MANAGED_GIT_GITHUB_INSTALL_ID,
  MANAGED_GIT_GITHUB_TOKEN: env.MANAGED_GIT_GITHUB_TOKEN,
  CODE_STORAGE_ORG: env.CODE_STORAGE_ORG,
  CODE_STORAGE_PRIVATE_KEY: env.CODE_STORAGE_PRIVATE_KEY,
  CODE_STORAGE_API_BASE: env.CODE_STORAGE_API_BASE,
  CODE_STORAGE_GIT_HOST: env.CODE_STORAGE_GIT_HOST,
  KORTIX_REQUIRE_DECLARED_AGENTS: env.KORTIX_REQUIRE_DECLARED_AGENTS,

  // ─── Legacy migration ─────────────────────────────────────────────────────
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
  SLACK_REQUIRE_USER_IDENTITY: env.SLACK_REQUIRE_USER_IDENTITY,

  // ─── Channels (AgentMail email) ──────────────────────────────────────────
  AGENTMAIL_API_URL: env.AGENTMAIL_API_URL,
  AGENTMAIL_API_KEY: env.AGENTMAIL_API_KEY,
  AGENTMAIL_WEBHOOK_SECRET: env.AGENTMAIL_WEBHOOK_SECRET,

  // ─── Channels (Microsoft Teams) ───────────────────────────────────────────
  MICROSOFT_APP_ID: env.MICROSOFT_APP_ID,
  MICROSOFT_APP_PASSWORD: env.MICROSOFT_APP_PASSWORD,
  MICROSOFT_APP_TENANT: env.MICROSOFT_APP_TENANT,
  MICROSOFT_BOT_OPENID_METADATA: env.MICROSOFT_BOT_OPENID_METADATA,
  TEAMS_REQUIRE_USER_IDENTITY: env.TEAMS_REQUIRE_USER_IDENTITY,
  TEAMS_APP_NAME: env.TEAMS_APP_NAME,

  // ─── LLM Providers ────────────────────────────────────────────────────────
  OPENROUTER_API_URL: env.OPENROUTER_API_URL,
  OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
  MORPH_API_URL: env.MORPH_API_URL,
  MORPH_API_KEY: env.MORPH_API_KEY,
  MORPH_MANAGED_MODELS: env.MORPH_MANAGED_MODELS,
  CONNECTORS_MCP_ENABLED: env.CONNECTORS_MCP_ENABLED,
  LLM_GATEWAY_ENABLED: env.LLM_GATEWAY_ENABLED,
  // Unset → follow billing (cloud keeps its revenue lineup even if the env
  // blob misses the var; self-host stays off). Explicit value always wins.
  KORTIX_MANAGED_PROVIDER_ENABLED:
    env.KORTIX_MANAGED_PROVIDER_ENABLED ?? env.KORTIX_BILLING_INTERNAL_ENABLED,
  LLM_GATEWAY_DEFAULT_ENABLED: env.LLM_GATEWAY_DEFAULT_ENABLED,
  LLM_GATEWAY_BASE_URL: env.LLM_GATEWAY_BASE_URL,
  LLM_GATEWAY_DEFAULT_MODEL: env.LLM_GATEWAY_DEFAULT_MODEL,
  LLM_GATEWAY_VISION_MODEL: env.LLM_GATEWAY_VISION_MODEL,
  LLM_GATEWAY_FALLBACK_POLICIES: env.LLM_GATEWAY_FALLBACK_POLICIES,
  LLM_GATEWAY_MANAGED_MODELS: env.LLM_GATEWAY_MANAGED_MODELS,
  LLM_GATEWAY_CATALOG_URL: env.LLM_GATEWAY_CATALOG_URL,
  LLM_GATEWAY_BYOK_FALLBACK_MODEL: env.LLM_GATEWAY_BYOK_FALLBACK_MODEL,
  LLM_GATEWAY_PROXY_PORT: env.LLM_GATEWAY_PROXY_PORT,
  LLM_GATEWAY_PROXY_TARGET: env.LLM_GATEWAY_PROXY_TARGET,
  OPENAI_API_URL: env.OPENAI_API_URL,
  OPENAI_API_KEY: env.OPENAI_API_KEY,
  XAI_API_URL: env.XAI_API_URL,
  GEMINI_API_URL: env.GEMINI_API_URL,
  GROQ_API_URL: env.GROQ_API_URL,
  LIVEKIT_URL: env.LIVEKIT_URL,
  LIVEKIT_API_KEY: env.LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET: env.LIVEKIT_API_SECRET,
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
  DAYTONA_WEBHOOK_SECRET: env.DAYTONA_WEBHOOK_SECRET,
  KORTIX_SNAPSHOT_REAP_PREDECESSOR: env.KORTIX_SNAPSHOT_REAP_PREDECESSOR,
  KORTIX_PI_WORKER_POOL_TARGET: env.KORTIX_PI_WORKER_POOL_TARGET,
  KORTIX_PI_WORKER_POOL_MAX_AGE_MINUTES: env.KORTIX_PI_WORKER_POOL_MAX_AGE_MINUTES,
  KORTIX_FAST_GIT_BOOT_ENABLED: env.KORTIX_FAST_GIT_BOOT_ENABLED,
  KORTIX_COMPILED_BOOT_MODE: env.KORTIX_COMPILED_BOOT_MODE,
  KORTIX_PROJECT_SNAPSHOT_MODE: env.KORTIX_PROJECT_SNAPSHOT_MODE,
  KORTIX_PROJECT_SNAPSHOT_S3_BUCKET: env.KORTIX_PROJECT_SNAPSHOT_S3_BUCKET,
  KORTIX_PROJECT_SNAPSHOT_S3_REGION: env.KORTIX_PROJECT_SNAPSHOT_S3_REGION,
  KORTIX_PROJECT_SNAPSHOT_S3_ENDPOINT: env.KORTIX_PROJECT_SNAPSHOT_S3_ENDPOINT,
  KORTIX_PROJECT_SNAPSHOT_S3_PUBLIC_ENDPOINT: env.KORTIX_PROJECT_SNAPSHOT_S3_PUBLIC_ENDPOINT,
  KORTIX_PROJECT_SNAPSHOT_S3_FORCE_PATH_STYLE: env.KORTIX_PROJECT_SNAPSHOT_S3_FORCE_PATH_STYLE,
  KORTIX_PROJECT_SNAPSHOT_S3_ACCELERATE: env.KORTIX_PROJECT_SNAPSHOT_S3_ACCELERATE,
  KORTIX_PROJECT_SNAPSHOT_S3_PREFIX: env.KORTIX_PROJECT_SNAPSHOT_S3_PREFIX,
  KORTIX_PROJECT_SNAPSHOT_S3_ACCESS_KEY_ID: env.KORTIX_PROJECT_SNAPSHOT_S3_ACCESS_KEY_ID,
  KORTIX_PROJECT_SNAPSHOT_S3_SECRET_ACCESS_KEY: env.KORTIX_PROJECT_SNAPSHOT_S3_SECRET_ACCESS_KEY,
  KORTIX_PROJECT_SNAPSHOT_DOWNLOAD_TTL_SECONDS: env.KORTIX_PROJECT_SNAPSHOT_DOWNLOAD_TTL_SECONDS,
  KORTIX_CONFIG_ARCHIVE_S3_BUCKET: env.KORTIX_CONFIG_ARCHIVE_S3_BUCKET,
  KORTIX_CONFIG_ARCHIVE_S3_REGION: env.KORTIX_CONFIG_ARCHIVE_S3_REGION,
  KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT: env.KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT,
  KORTIX_CONFIG_ARCHIVE_S3_FORCE_PATH_STYLE: env.KORTIX_CONFIG_ARCHIVE_S3_FORCE_PATH_STYLE,
  KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID: env.KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID,
  KORTIX_CONFIG_ARCHIVE_S3_SECRET_ACCESS_KEY: env.KORTIX_CONFIG_ARCHIVE_S3_SECRET_ACCESS_KEY,
  KORTIX_CONFIG_ARCHIVE_S3_PREFIX: env.KORTIX_CONFIG_ARCHIVE_S3_PREFIX,
  KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT: env.KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT,
  KORTIX_CONFIG_ARCHIVE_PUBLIC_URL: env.KORTIX_CONFIG_ARCHIVE_PUBLIC_URL,
  KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES: env.KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES,

  // Sandbox lifecycle intervals (minutes) — see schema comment above.
  KORTIX_SANDBOX_AUTOSTOP_MINUTES: env.KORTIX_SANDBOX_AUTOSTOP_MINUTES,
  KORTIX_SANDBOX_TRIGGER_AUTOSTOP_MINUTES: env.KORTIX_SANDBOX_TRIGGER_AUTOSTOP_MINUTES,
  KORTIX_SANDBOX_AUTOARCHIVE_MINUTES: env.KORTIX_SANDBOX_AUTOARCHIVE_MINUTES,
  KORTIX_SANDBOX_AUTODELETE_MINUTES: env.KORTIX_SANDBOX_AUTODELETE_MINUTES,
  KORTIX_SANDBOX_PROVIDER_AUTOSTOP_MINUTES: env.KORTIX_SANDBOX_PROVIDER_AUTOSTOP_MINUTES,

  PLATINUM_API_KEY: env.PLATINUM_API_KEY,
  PLATINUM_API_URL: env.PLATINUM_API_URL,
  PLATINUM_TEMPLATE: env.PLATINUM_TEMPLATE,
  PLATINUM_WEBHOOK_SECRET: env.PLATINUM_WEBHOOK_SECRET,
  E2B_API_KEY: env.E2B_API_KEY,
  E2B_DOMAIN: env.E2B_DOMAIN,
  E2B_TEMPLATE: env.E2B_TEMPLATE,
  // ─── Sandbox Provisioning (Platform) ──────────────────────────────────────
  KORTIX_URL: env.KORTIX_URL,
  ALLOWED_SANDBOX_PROVIDERS: allowedProviders,

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
        const { appendFileSync, readFileSync } = require('fs');
        const { resolve } = require('path');
        const candidates = [
          resolve(__dirname, '../../.env'), // from src/config.ts -> ../../.env
          resolve(process.cwd(), '.env'), // cwd/.env
        ];
        for (const envPath of candidates) {
          // No existsSync-then-write: check-then-act on a path is a TOCTOU race.
          // The read IS the existence test — a missing/unreadable file throws us
          // to the next candidate, leaving no gap between check and use.
          let content: string;
          try {
            content = readFileSync(envPath, 'utf-8');
          } catch {
            continue;
          }
          if (!content.includes('INTERNAL_SERVICE_KEY=')) {
            appendFileSync(
              envPath,
              `\n# Auto-generated service key for sandbox auth (do not remove)\nINTERNAL_SERVICE_KEY=${generated}\n`,
            );
            console.log(`[config] Persisted INTERNAL_SERVICE_KEY to ${envPath}`);
          }
          break;
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
  KORTIX_PUBLIC_SESSION_SHARE_REQS_PER_MIN: env.KORTIX_PUBLIC_SESSION_SHARE_REQS_PER_MIN,
  KORTIX_DEMO_REQUEST_REQS_PER_MIN: env.KORTIX_DEMO_REQUEST_REQS_PER_MIN,
  KORTIX_VOICE_JOIN_LINK_REQS_PER_MIN: env.KORTIX_VOICE_JOIN_LINK_REQS_PER_MIN,
  KORTIX_VOICE_TRANSCRIPT_REQS_PER_MIN: env.KORTIX_VOICE_TRANSCRIPT_REQS_PER_MIN,
  KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE: env.KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE,
  KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID: env.KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID,
  KORTIX_LLM_GATEWAY_REQS_PER_MIN: env.KORTIX_LLM_GATEWAY_REQS_PER_MIN,
  KORTIX_PROXY_REQS_PER_MIN: env.KORTIX_PROXY_REQS_PER_MIN,
  KORTIX_TRUSTED_PROXY_HOPS: env.KORTIX_TRUSTED_PROXY_HOPS,
  KORTIX_UNKNOWN_TOKEN_ATTEMPTS_PER_MIN: env.KORTIX_UNKNOWN_TOKEN_ATTEMPTS_PER_MIN,
  KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT:
    env.KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT,
  KORTIX_TRIGGER_SCHEDULER_ENABLED: env.KORTIX_TRIGGER_SCHEDULER_ENABLED,
  KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS: env.KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS,

  // ─── Version / GitHub ──────────────────────────────────────────────────────
  /** Dev override: force a specific sandbox version via env var. */
  SANDBOX_VERSION_OVERRIDE: env.SANDBOX_VERSION,
  GITHUB_TOKEN: env.GITHUB_TOKEN,

  // ─── Transactional email (provider chain) ──────────────────────────────────
  EMAIL_URL: env.EMAIL_URL,
  EMAIL_FROM: env.EMAIL_FROM,
  AUTH_EMAIL_HOOK_SECRET: env.AUTH_EMAIL_HOOK_SECRET,
  EMAIL_PROVIDER_ORDER: env.EMAIL_PROVIDER_ORDER,
  SMTP_HOST: env.SMTP_HOST,
  SMTP_PORT: env.SMTP_PORT,
  SMTP_USER: env.SMTP_USER,
  SMTP_PASS: env.SMTP_PASS,
  AWS_SES_REGION: env.AWS_SES_REGION,
  AWS_SES_ACCESS_KEY_ID: env.AWS_SES_ACCESS_KEY_ID,
  AWS_SES_SECRET_ACCESS_KEY: env.AWS_SES_SECRET_ACCESS_KEY,
  RESEND_API_KEY: env.RESEND_API_KEY,
  RESEND_FROM_EMAIL: env.RESEND_FROM_EMAIL,
  EXPO_ACCESS_TOKEN: env.EXPO_ACCESS_TOKEN,
  PUSH_NOTIFICATIONS_ENABLED: env.PUSH_NOTIFICATIONS_ENABLED,
  MAILPIT_API_URL: env.MAILPIT_API_URL,
  MAILTRAP_API_TOKEN: env.MAILTRAP_API_TOKEN,
  MAILTRAP_FROM_EMAIL: env.MAILTRAP_FROM_EMAIL,
  MAILTRAP_FROM_NAME: env.MAILTRAP_FROM_NAME,
  DEMO_LEAD_NOTIFY_EMAIL: env.DEMO_LEAD_NOTIFY_EMAIL,
  DEMO_LEAD_FROM_EMAIL: env.DEMO_LEAD_FROM_EMAIL,

  // ─── Mailtrap contact sync (signup → automation lists) ────────────────────
  MAILTRAP_ACCOUNT_ID: env.MAILTRAP_ACCOUNT_ID,
  MAILTRAP_SIGNUPS_LIST_ID: env.MAILTRAP_SIGNUPS_LIST_ID,
  MAILTRAP_BUSINESS_SIGNUPS_LIST_ID: env.MAILTRAP_BUSINESS_SIGNUPS_LIST_ID,

  // ─── Stray env vars (centralized from other files) ────────────────────────
  CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS,
  KORTIX_MASTER_URL: env.KORTIX_MASTER_URL,
  OPENCODE_URL: env.OPENCODE_URL,
  KORTIX_DATA_DIR: env.KORTIX_DATA_DIR,

  // ─── Helper Methods ────────────────────────────────────────────────────────

  isProviderEnabled(name: SandboxProviderName): boolean {
    if (!this.ALLOWED_SANDBOX_PROVIDERS.includes(name)) return false;
    switch (name) {
      case 'daytona':
        return !!this.DAYTONA_API_KEY;
      case 'platinum':
        return !!this.PLATINUM_API_KEY;
      case 'e2b':
        return !!this.E2B_API_KEY;
      default: {
        const exhaustive: never = name;
        return exhaustive;
      }
    }
  },

  /**
   * Default sandbox provider for new sessions. First entry of
   * ALLOWED_SANDBOX_PROVIDERS, with 'daytona' as the safety belt for an
   * empty list. The ordering is the automatic-selection preference; callers
   * that explicitly choose a provider bypass that preference.
   */
  getDefaultProvider(): SandboxProviderName {
    return this.ALLOWED_SANDBOX_PROVIDERS[0] ?? 'daytona';
  },

  isDaytonaEnabled(): boolean {
    return this.ALLOWED_SANDBOX_PROVIDERS.includes('daytona') && !!this.DAYTONA_API_KEY;
  },

  isPlatinumEnabled(): boolean {
    return this.ALLOWED_SANDBOX_PROVIDERS.includes('platinum') && !!this.PLATINUM_API_KEY;
  },

  isE2BEnabled(): boolean {
    return this.ALLOWED_SANDBOX_PROVIDERS.includes('e2b') && !!this.E2B_API_KEY;
  },
};
