export const PREVIEW_RUNTIME_SECRET_ALLOWLIST = [
  'DAYTONA_API_KEY',
  'KE2E_STRIPE_SECRET_KEY',
  'KE2E_STRIPE_WEBHOOK_SECRET',
  'KORTIX_GITHUB_APP_ID',
  'KORTIX_GITHUB_APP_PRIVATE_KEY',
  'KORTIX_GITHUB_APP_SLUG',
  'MANAGED_GIT_GITHUB_INSTALL_ID',
  'MANAGED_GIT_GITHUB_OWNER',
  'OPENROUTER_API_KEY',
] as const;

export type PreviewRuntimeSecretName = (typeof PREVIEW_RUNTIME_SECRET_ALLOWLIST)[number];
export type PreviewRuntimeSecrets = Partial<Record<PreviewRuntimeSecretName, string>>;

export interface PreviewStackInput {
  origin: string;
  sha: string;
  apiImage: string;
  gatewayImage: string;
  frontendImage: string;
}

function validatedOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('preview origin must be an HTTPS origin without a path');
  }
  return url.origin;
}

function validatedValue(value: string, key: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error(`${key} contains an invalid control character`);
  return value;
}

function parseEnvironment(text: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith('#') || !raw.includes('=')) continue;
    const separator = raw.indexOf('=');
    environment[raw.slice(0, separator)] = raw.slice(separator + 1);
  }
  return environment;
}

function renderEnvironment(environment: Record<string, string>): string {
  return `${Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${validatedValue(value, key)}`)
    .join('\n')}\n`;
}

export function validatePreviewRuntimeSecrets(
  secrets: Record<string, string>,
): asserts secrets is PreviewRuntimeSecrets {
  const allowed = new Set<string>(PREVIEW_RUNTIME_SECRET_ALLOWLIST);
  const unexpected = Object.keys(secrets).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`preview runtime secret is not allowlisted: ${unexpected.sort().join(', ')}`);
  }
  for (const [key, value] of Object.entries(secrets)) {
    if (key === 'KORTIX_GITHUB_APP_PRIVATE_KEY') {
      if (value.includes('\0')) throw new Error(`${key} contains an invalid control character`);
    } else {
      validatedValue(value, key);
    }
  }
}

export function buildPreviewCaddyfile(): string {
  return `:8080 {
  encode zstd gzip

  @api path /v1*
  handle @api {
    reverse_proxy kortix-api:8008
  }

  @supabase path /auth/v1* /rest/v1* /storage/v1* /realtime/v1* /functions/v1* /graphql/v1*
  handle @supabase {
    reverse_proxy supabase-kong:8000
  }

  handle_path /_gateway/* {
    reverse_proxy llm-gateway:8090
  }

  handle_path /_tests/* {
    root * /reports
    file_server browse
  }

  handle_path /_mailpit/* {
    reverse_proxy mailpit:8025
  }

  handle {
    reverse_proxy frontend:3000
  }
}
`;
}

export function buildPreviewComposeOverlay(
  reportPath: string,
  caddyfilePath = '/workspace/kortix-preview/Caddyfile.preview',
): string {
  if (!reportPath.startsWith('/') || !caddyfilePath.startsWith('/')) {
    throw new Error('preview bind mounts require absolute paths');
  }
  validatedValue(reportPath, 'reportPath');
  validatedValue(caddyfilePath, 'caddyfilePath');
  return `services:
  preview-edge:
    image: caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
    ports:
      - "0.0.0.0:8080:8080"
    volumes:
      - "${caddyfilePath}:/etc/caddy/Caddyfile:ro"
      - "${reportPath}:/reports:ro"
    depends_on:
      frontend:
        condition: service_healthy
      kortix-api:
        condition: service_healthy
      supabase-kong:
        condition: service_healthy
      mailpit:
        condition: service_started
    restart: unless-stopped
  mailpit:
    image: axllent/mailpit:v1.27.8@sha256:6abc8e633df15eaf785cfcf38bae48e66f64beecdc03121e249d0f9ec15f0707
    restart: unless-stopped
  supabase-db:
    ports:
      - "127.0.0.1:15432:5432"
`;
}

export function applyPreviewEnvironment(
  baseEnvironmentText: string,
  input: PreviewStackInput,
  rawSecrets: Record<string, string>,
): { runtimeEnv: string; testEnv: string } {
  validatePreviewRuntimeSecrets(rawSecrets);
  if (!/^[0-9a-f]{40}$/.test(input.sha)) throw new Error('preview SHA must contain 40 hex characters');
  const origin = validatedOrigin(input.origin);
  const runtime = parseEnvironment(baseEnvironmentText);
  const postgresPassword = runtime.POSTGRES_PASSWORD;
  const anonKey = runtime.SUPABASE_ANON_KEY;
  const serviceRoleKey = runtime.SUPABASE_SERVICE_ROLE_KEY;
  const internalServiceKey = runtime.INTERNAL_SERVICE_KEY;
  if (!postgresPassword || !anonKey || !serviceRoleKey || !internalServiceKey) {
    throw new Error('self-host environment is missing generated preview credentials');
  }
  const managedGitValues = [
    rawSecrets.KORTIX_GITHUB_APP_ID,
    rawSecrets.KORTIX_GITHUB_APP_PRIVATE_KEY,
    rawSecrets.KORTIX_GITHUB_APP_SLUG,
    rawSecrets.MANAGED_GIT_GITHUB_INSTALL_ID,
    rawSecrets.MANAGED_GIT_GITHUB_OWNER,
  ];
  const managedGitEnabled = managedGitValues.every((value) => Boolean(value?.trim()));
  if (!managedGitEnabled) {
    throw new Error('preview target-full requires the complete managed GitHub App configuration');
  }

  Object.assign(runtime, {
    API_IMAGE: input.apiImage,
    GATEWAY_IMAGE: input.gatewayImage,
    FRONTEND_IMAGE: input.frontendImage,
    KORTIX_VERSION: `pr-${input.sha}`,
    KORTIX_COMMIT: input.sha,
    INTERNAL_KORTIX_ENV: 'preview',
    ENV_MODE: 'local',
    PUBLIC_URL: origin,
    API_PUBLIC_URL: origin,
    SUPABASE_PUBLIC_URL: origin,
    KORTIX_URL: origin,
    FRONTEND_URL: origin,
    SITE_URL: origin,
    API_EXTERNAL_URL: `${origin}/auth/v1`,
    ADDITIONAL_REDIRECT_URLS: `${origin}/auth/callback`,
    CORS_ALLOWED_ORIGINS: origin,
    KORTIX_PUBLIC_APP_URL: origin,
    KORTIX_PUBLIC_AUTH_METHODS: 'magic,password',
    KORTIX_PUBLIC_DISABLE_LANDING_PAGE: 'true',
    KORTIX_RESTRICT_ACCOUNT_CREATION: 'false',
    KORTIX_PUBLIC_RESTRICT_ACCOUNT_CREATION: 'false',
    KORTIX_BILLING_INTERNAL_ENABLED: 'true',
    KORTIX_PUBLIC_BILLING_ENABLED: 'true',
    KORTIX_WORKERS_ENABLED: 'false',
    SCHEDULER_ENABLED: 'false',
    KORTIX_TRIGGER_SCHEDULER_ENABLED: 'false',
    EMAIL_PROVIDER_ORDER: 'mailpit',
    MAILPIT_API_URL: 'http://mailpit:8025',
    SMTP_HOST: 'mailpit',
    SMTP_PORT: '1025',
    SMTP_USER: 'unused',
    SMTP_PASS: 'unused',
    ENABLE_EMAIL_AUTOCONFIRM: 'false',
    ALLOWED_SANDBOX_PROVIDERS: 'daytona',
    DATABASE_URL: `postgresql://postgres:${postgresPassword}@supabase-db:5432/postgres`,
    DAYTONA_API_KEY: rawSecrets.DAYTONA_API_KEY ?? '',
    MANAGED_GIT_PROVIDER: 'github',
    MANAGED_GIT_GITHUB_OWNER: rawSecrets.MANAGED_GIT_GITHUB_OWNER ?? '',
    MANAGED_GIT_GITHUB_INSTALL_ID: rawSecrets.MANAGED_GIT_GITHUB_INSTALL_ID ?? '',
    KORTIX_GITHUB_APP_ID: rawSecrets.KORTIX_GITHUB_APP_ID ?? '',
    KORTIX_GITHUB_APP_PRIVATE_KEY:
      rawSecrets.KORTIX_GITHUB_APP_PRIVATE_KEY?.replace(/\r?\n/g, '\\n') ?? '',
    KORTIX_GITHUB_APP_SLUG: rawSecrets.KORTIX_GITHUB_APP_SLUG ?? '',
    OPENROUTER_API_KEY: rawSecrets.OPENROUTER_API_KEY ?? '',
    STRIPE_SECRET_KEY: rawSecrets.KE2E_STRIPE_SECRET_KEY ?? '',
    STRIPE_WEBHOOK_SECRET: rawSecrets.KE2E_STRIPE_WEBHOOK_SECRET ?? '',
  });

  const testEnvironment: Record<string, string> = {
    CI: '1',
    KE2E_TARGET: 'preview',
    KE2E_LIVE_CONFIRM: 'preview',
    KE2E_PREVIEW_ORIGIN: origin,
    KE2E_PREVIEW_AUTHORIZATION: `approved:${input.sha}`,
    KE2E_EXPECT_SHA: input.sha,
    KE2E_API_URL: `${origin}/v1`,
    E2E_API_URL: `${origin}/v1`,
    KE2E_BASE_URL: origin,
    E2E_BASE_URL: origin,
    KE2E_GATEWAY_URL: `${origin}/_gateway`,
    KE2E_SUPABASE_URL: origin,
    E2E_SUPABASE_URL: origin,
    E2E_MAILPIT_URL: `${origin}/_mailpit`,
    KE2E_DATABASE_URL: `postgresql://postgres:${postgresPassword}@127.0.0.1:15432/postgres`,
    E2E_DATABASE_URL: `postgresql://postgres:${postgresPassword}@127.0.0.1:15432/postgres`,
    KE2E_SUPABASE_ANON_KEY: anonKey,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
    KE2E_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    KE2E_INTERNAL_SERVICE_KEY: internalServiceKey,
    KE2E_STRIPE_SECRET_KEY: rawSecrets.KE2E_STRIPE_SECRET_KEY ?? '',
    KE2E_STRIPE_WEBHOOK_SECRET: rawSecrets.KE2E_STRIPE_WEBHOOK_SECRET ?? '',
    E2E_AGENTMAIL_API_KEY: '',
    KE2E_CAP_DAYTONA: rawSecrets.DAYTONA_API_KEY ? '1' : '0',
    KE2E_CAP_MANAGED_GIT: managedGitEnabled ? '1' : '0',
    KE2E_CAP_MANAGED_GIT_PUSH: managedGitEnabled ? '1' : '0',
    KE2E_DEFAULT_FLOW_ATTEMPTS: '1',
  };

  return {
    runtimeEnv: renderEnvironment(runtime),
    testEnv: renderEnvironment(testEnvironment),
  };
}
