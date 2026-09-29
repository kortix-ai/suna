import { describe, expect, test } from 'bun:test';
import {
  KNOWN_PROVIDERS,
  KORTIX_MARKUP,
  MORPH_MANAGED_MODELS_DEFAULT,
  SANDBOX_VERSION,
  config,
  getToolCost,
  parseAllowedProviders,
  parseMorphManagedModels,
} from './config';

/**
 * Characterization tests for the config module's boot contract.
 *
 * They pin the behavior a restructure of src/config.ts must preserve:
 * validateEnv's boot report (exit code, printed var names, the
 * warn-vs-error provider branch, the KORTIX_URL auto-derive side effect),
 * the exact key set of the exported `config` object, and the moved
 * pricing/provider helpers.
 *
 * Every broken-env case runs config.ts in a child process: importing it
 * validates env at module load and process.exit(1)s on errors, which must
 * not kill the test runner. cwd is src/ and bun does not walk up to
 * apps/api/.env, so the child sees exactly the env passed here.
 */

const source = new URL('./config.ts', import.meta.url).pathname;

const base = {
  PATH: process.env.PATH ?? '',
  DATABASE_URL: 'postgres://localhost/test',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-role',
  API_KEY_SECRET: 'synthetic-api-secret',
  TUNNEL_ENABLED: 'false',
  KORTIX_URL: 'http://localhost:8008',
  ALLOWED_SANDBOX_PROVIDERS: 'e2b',
};

function load(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `const { config } = await import(${JSON.stringify(source)}); console.log('CONFIG_STATE=' + JSON.stringify({ keys: Object.keys(config), kortixUrl: config.KORTIX_URL, providers: config.ALLOWED_SANDBOX_PROVIDERS }));`,
    ],
    { env, cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' },
  );
  const marker = result.stdout.toString().split('CONFIG_STATE=')[1];
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString().replaceAll(/\x1b\[[0-9;]*m/g, ''),
    state: JSON.parse(marker ? marker.split('\n')[0] : '{}') as {
      keys?: string[];
      kortixUrl?: string;
      providers?: string[];
    },
  };
}

describe('config module boot characterization', () => {
  test.each(['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'API_KEY_SECRET'])(
    'missing %s prevents startup',
    (key) => {
      const result = load({ [key]: undefined });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Environment validation FAILED');
      expect(result.stderr).toContain(key);
    },
  );

  test('invalid Supabase URL prevents startup', () => {
    const result = load({ SUPABASE_URL: 'not-a-url' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('SUPABASE_URL');
    expect(result.stderr).toContain('must be a valid HTTP(S) URL');
  });

  test('billing enabled turns missing provider and Stripe keys into fatal errors', () => {
    const result = load({ KORTIX_BILLING_INTERNAL_ENABLED: 'true', ALLOWED_SANDBOX_PROVIDERS: 'daytona,e2b' });
    expect(result.exitCode).toBe(1);
    for (const key of ['DAYTONA_API_KEY', 'DAYTONA_SERVER_URL', 'DAYTONA_TARGET', 'E2B_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) {
      expect(result.stderr).toContain(key);
    }
  });

  test('billing off downgrades the same missing provider keys to warnings', () => {
    const result = load({ ALLOWED_SANDBOX_PROVIDERS: 'daytona' });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Environment warnings');
    expect(result.stderr).toContain('DAYTONA_API_KEY');
  });

  test('config releases with a custom endpoint require credentials', () => {
    const result = load({
      CONFIG_RELEASES_ENABLED: 'true',
      KORTIX_CONFIG_ARCHIVE_S3_BUCKET: 'synthetic-bucket',
      KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT: 'http://localhost:9000',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID');
  });

  test('enabled tunnel requires a signing secret', () => {
    const result = load({ TUNNEL_ENABLED: undefined, TUNNEL_SIGNING_SECRET: undefined });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('TUNNEL_SIGNING_SECRET');
  });

  test('unset KORTIX_URL is auto-derived, not fatal', () => {
    const result = load({ KORTIX_URL: undefined });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('auto-derived');
    expect(result.state.kortixUrl).toBe('http://localhost:8008');
    expect(result.state.providers).toEqual(['e2b']);
  });

  test('exported config exposes every key', () => {
    const result = load();
    expect(result.exitCode).toBe(0);
    expect(result.state.keys).toEqual([
      'PORT',
      'INTERNAL_KORTIX_ENV',
      'KORTIX_INSTANCE_ID',
      'KORTIX_PREVIEW_BASE_DOMAIN',
      'KORTIX_BILLING_INTERNAL_ENABLED',
      'KORTIX_WORKERS_ENABLED',
      'KORTIX_SANDBOX_EGRESS_PIN_ENFORCED',
      'KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS',
      'KORTIX_SECRET_RELAY_STREAM_ENABLED',
      'KORTIX_RELAY_WS_ENABLED',
      'KORTIX_RELAY_MAX_REQUEST_BYTES',
      'KORTIX_RELAY_MAX_RESPONSE_BYTES',
      'KORTIX_RELAY_HEADERS_TIMEOUT_MS',
      'KORTIX_RELAY_UPSTREAM_IDLE_TIMEOUT_MS',
      'SESSION_TITLE_GENERATION_ENABLED',
      'KORTIX_TEMPLATES_ENABLED',
      'OPENAPI_PUBLIC_DOCS',
      'ENTERPRISE_LICENSE_AVAILABLE',
      'KORTIX_RESTRICT_ACCOUNT_CREATION',
      'DATABASE_URL',
      'SUPABASE_URL',
      'SUPABASE_PUBLIC_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_ANON_KEY',
      'KORTIX_PUBLIC_AUTH_METHODS',
      'KORTIX_PUBLIC_AUTH_PROVIDERS',
      'SUPABASE_JWT_SECRET',
      'SUPABASE_JWT_LIVENESS_TTL_MS',
      'PROMPT_ATTACHMENT_UPLOAD_MODE',
      'PROMPT_ATTACHMENT_CHUNK_BYTES',
      'API_KEY_SECRET',
      'PIPEDREAM_CLIENT_ID',
      'PIPEDREAM_CLIENT_SECRET',
      'PIPEDREAM_PROJECT_ID',
      'PIPEDREAM_ENVIRONMENT',
      'PIPEDREAM_WEBHOOK_SECRET',
      'COMPOSIO_API_KEY',
      'POSTMAN_API_KEY',
      'TAVILY_API_URL',
      'TAVILY_API_KEY',
      'SERPER_API_URL',
      'SERPER_API_KEY',
      'FIRECRAWL_API_URL',
      'FIRECRAWL_API_KEY',
      'CONTEXT7_API_URL',
      'CONTEXT7_API_KEY',
      'MANAGED_GIT_PROVIDER',
      'MANAGED_GIT_GITHUB_OWNER',
      'MANAGED_GIT_GITHUB_INSTALL_ID',
      'MANAGED_GIT_GITHUB_TOKEN',
      'CODE_STORAGE_ORG',
      'CODE_STORAGE_PRIVATE_KEY',
      'CODE_STORAGE_API_BASE',
      'CODE_STORAGE_GIT_HOST',
      'KORTIX_REQUIRE_DECLARED_AGENTS',
      'LEGACY_MIGRATION_BACKUP_BUCKET',
      'SLACK_BOT_TOKEN',
      'SLACK_SIGNING_SECRET',
      'SLACK_TEAM_ID',
      'SLACK_CLIENT_ID',
      'SLACK_CLIENT_SECRET',
      'SLACK_REDIRECT_URI',
      'SLACK_OAUTH_SCOPES',
      'SLACK_HOME_HERO_URL',
      'SLACK_REQUIRE_USER_IDENTITY',
      'AGENTMAIL_API_URL',
      'AGENTMAIL_API_KEY',
      'AGENTMAIL_WEBHOOK_SECRET',
      'MICROSOFT_APP_ID',
      'MICROSOFT_APP_PASSWORD',
      'MICROSOFT_APP_TENANT',
      'MICROSOFT_BOT_OPENID_METADATA',
      'TEAMS_REQUIRE_USER_IDENTITY',
      'TEAMS_APP_NAME',
      'OPENROUTER_API_URL',
      'OPENROUTER_API_KEY',
      'MORPH_API_URL',
      'MORPH_API_KEY',
      'MORPH_MANAGED_MODELS',
      'CONNECTORS_MCP_ENABLED',
      'LLM_GATEWAY_ENABLED',
      'KORTIX_MANAGED_PROVIDER_ENABLED',
      'LLM_GATEWAY_DEFAULT_ENABLED',
      'LLM_GATEWAY_BASE_URL',
      'LLM_GATEWAY_DEFAULT_MODEL',
      'LLM_GATEWAY_VISION_MODEL',
      'LLM_GATEWAY_FALLBACK_POLICIES',
      'LLM_GATEWAY_MANAGED_MODELS',
      'LLM_GATEWAY_CATALOG_URL',
      'LLM_GATEWAY_BYOK_FALLBACK_MODEL',
      'LLM_GATEWAY_PROXY_PORT',
      'LLM_GATEWAY_PROXY_TARGET',
      'OPENAI_API_URL',
      'OPENAI_API_KEY',
      'XAI_API_URL',
      'GEMINI_API_URL',
      'GROQ_API_URL',
      'LIVEKIT_URL',
      'LIVEKIT_API_KEY',
      'LIVEKIT_API_SECRET',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'REVENUECAT_WEBHOOK_SECRET',
      'DAYTONA_API_KEY',
      'DAYTONA_SERVER_URL',
      'DAYTONA_TARGET',
      'DAYTONA_WEBHOOK_SECRET',
      'KORTIX_SNAPSHOT_REAP_PREDECESSOR',
      'KORTIX_PI_WORKER_POOL_TARGET',
      'KORTIX_PI_WORKER_POOL_MAX_AGE_MINUTES',
      'KORTIX_FAST_GIT_BOOT_ENABLED',
      'KORTIX_COMPILED_BOOT_MODE',
      'KORTIX_PROJECT_SNAPSHOT_MODE',
      'KORTIX_PROJECT_SNAPSHOT_S3_BUCKET',
      'KORTIX_PROJECT_SNAPSHOT_S3_REGION',
      'KORTIX_PROJECT_SNAPSHOT_S3_ENDPOINT',
      'KORTIX_PROJECT_SNAPSHOT_S3_PUBLIC_ENDPOINT',
      'KORTIX_PROJECT_SNAPSHOT_S3_FORCE_PATH_STYLE',
      'KORTIX_PROJECT_SNAPSHOT_S3_ACCELERATE',
      'KORTIX_PROJECT_SNAPSHOT_S3_PREFIX',
      'KORTIX_PROJECT_SNAPSHOT_S3_ACCESS_KEY_ID',
      'KORTIX_PROJECT_SNAPSHOT_S3_SECRET_ACCESS_KEY',
      'KORTIX_PROJECT_SNAPSHOT_DOWNLOAD_TTL_SECONDS',
      'CONFIG_RELEASES_ENABLED',
      'KORTIX_CONFIG_ARCHIVE_S3_BUCKET',
      'KORTIX_CONFIG_ARCHIVE_S3_REGION',
      'KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT',
      'KORTIX_CONFIG_ARCHIVE_S3_FORCE_PATH_STYLE',
      'KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID',
      'KORTIX_CONFIG_ARCHIVE_S3_SECRET_ACCESS_KEY',
      'KORTIX_CONFIG_ARCHIVE_S3_PREFIX',
      'KORTIX_CONFIG_ARCHIVE_RETAIN_PER_PROJECT',
      'KORTIX_CONFIG_ARCHIVE_PUBLIC_URL',
      'KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES',
      'KORTIX_SANDBOX_AUTOSTOP_MINUTES',
      'KORTIX_SANDBOX_TRIGGER_AUTOSTOP_MINUTES',
      'KORTIX_SANDBOX_AUTOARCHIVE_MINUTES',
      'KORTIX_SANDBOX_AUTODELETE_MINUTES',
      'KORTIX_SANDBOX_PROVIDER_AUTOSTOP_MINUTES',
      'PLATINUM_API_KEY',
      'PLATINUM_API_URL',
      'PLATINUM_TEMPLATE',
      'PLATINUM_WEBHOOK_SECRET',
      'E2B_API_KEY',
      'E2B_DOMAIN',
      'E2B_TEMPLATE',
      'KORTIX_URL',
      'ALLOWED_SANDBOX_PROVIDERS',
      'INTERNAL_SERVICE_KEY',
      'FRONTEND_URL',
      'TUNNEL_SIGNING_SECRET',
      'TUNNEL_ENABLED',
      'TUNNEL_HEARTBEAT_INTERVAL_MS',
      'TUNNEL_HEARTBEAT_MAX_MISSED',
      'TUNNEL_RPC_TIMEOUT_MS',
      'TUNNEL_RATE_LIMIT_RPC',
      'TUNNEL_RATE_LIMIT_PERM_REQUEST',
      'TUNNEL_RATE_LIMIT_WS_CONNECT',
      'TUNNEL_RATE_LIMIT_PERM_GRANT',
      'TUNNEL_MAX_WS_MESSAGE_SIZE',
      'KORTIX_INVITE_ACCEPT_REQS_PER_MIN',
      'KORTIX_PUBLIC_SESSION_SHARE_REQS_PER_MIN',
      'KORTIX_DEMO_REQUEST_REQS_PER_MIN',
      'KORTIX_VOICE_JOIN_LINK_REQS_PER_MIN',
      'KORTIX_VOICE_TRANSCRIPT_REQS_PER_MIN',
      'KORTIX_LLM_ROUTER_REQS_PER_MIN_FREE',
      'KORTIX_LLM_ROUTER_REQS_PER_MIN_PAID',
      'KORTIX_LLM_GATEWAY_REQS_PER_MIN',
      'KORTIX_PROXY_REQS_PER_MIN',
      'KORTIX_TRUSTED_PROXY_HOPS',
      'KORTIX_UNKNOWN_TOKEN_ATTEMPTS_PER_MIN',
      'KORTIX_TRIGGER_MAX_PROVISIONING_SESSIONS_PER_PROJECT',
      'KORTIX_TRIGGER_SCHEDULER_ENABLED',
      'KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS',
      'SANDBOX_VERSION_OVERRIDE',
      'GITHUB_TOKEN',
      'EMAIL_URL',
      'EMAIL_FROM',
      'AUTH_EMAIL_HOOK_SECRET',
      'EMAIL_PROVIDER_ORDER',
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_USER',
      'SMTP_PASS',
      'AWS_SES_REGION',
      'AWS_SES_ACCESS_KEY_ID',
      'AWS_SES_SECRET_ACCESS_KEY',
      'RESEND_API_KEY',
      'RESEND_FROM_EMAIL',
      'EXPO_ACCESS_TOKEN',
      'PUSH_NOTIFICATIONS_ENABLED',
      'MAILPIT_API_URL',
      'MAILTRAP_API_TOKEN',
      'MAILTRAP_FROM_EMAIL',
      'MAILTRAP_FROM_NAME',
      'DEMO_LEAD_NOTIFY_EMAIL',
      'DEMO_LEAD_FROM_EMAIL',
      'MAILTRAP_ACCOUNT_ID',
      'MAILTRAP_SIGNUPS_LIST_ID',
      'MAILTRAP_BUSINESS_SIGNUPS_LIST_ID',
      'CORS_ALLOWED_ORIGINS',
      'KORTIX_MASTER_URL',
      'OPENCODE_URL',
      'KORTIX_DATA_DIR',
      'isProviderEnabled',
      'getDefaultProvider',
      'isDaytonaEnabled',
      'isPlatinumEnabled',
      'isE2BEnabled',
    ]);
  });
});

describe('config module exports characterization', () => {
  test('tool pricing math is unchanged', () => {
    expect(KORTIX_MARKUP).toBe(1.2);
    expect(getToolCost('web_search_basic')).toBe(0.0075);
    expect(getToolCost('web_search_basic', 5)).toBe(0.0075);
    expect(getToolCost('image_search')).toBeCloseTo(0.002);
    expect(getToolCost('unknown_tool')).toBe(0.01);
  });

  test('provider parsing contract is unchanged', () => {
    expect(KNOWN_PROVIDERS).toEqual(['daytona', 'platinum', 'e2b']);
    expect(parseAllowedProviders('')).toEqual(['daytona']);
    expect(parseAllowedProviders('daytona, platinum')).toEqual(['daytona', 'platinum']);
    expect(parseAllowedProviders('bogus', ['e2b'])).toEqual(['e2b']);
  });

  test('morph managed-models helpers are unchanged', () => {
    expect(MORPH_MANAGED_MODELS_DEFAULT).toBe('');
    expect(parseMorphManagedModels(MORPH_MANAGED_MODELS_DEFAULT)).toEqual([]);
    expect(parseMorphManagedModels('a, b,,c')).toEqual(['a', 'b', 'c']);
  });

  test('sandbox version export is present', () => {
    expect(typeof SANDBOX_VERSION).toBe('string');
  });
});
