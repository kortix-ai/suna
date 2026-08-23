import { pathToFileURL } from 'node:url';

const ENVIRONMENTS = {
  preview: {
    canonicalHost: 'dev.kortix.com',
    ecsHost: 'preview.kortix.com',
    apiHost: 'dev-api.kortix.com',
    protected: true,
  },
  dev: {
    canonicalHost: 'dev.kortix.com',
    ecsHost: 'dev.kortix.com',
    apiHost: 'dev-api.kortix.com',
    protected: true,
  },
  staging: {
    canonicalHost: 'staging.kortix.com',
    ecsHost: 'staging-fe-ecs.kortix.com',
    apiHost: 'staging-api.kortix.com',
    protected: true,
  },
  prod: {
    canonicalHost: 'kortix.com',
    ecsHost: 'prod-fe-ecs.kortix.com',
    apiHost: 'api.kortix.com',
    protected: false,
  },
};

const OPTIONAL_KEYS = [
  'EDGE_CONFIG',
  'EDGE_CONFIG_ID',
  'VERCEL_API_TOKEN',
  'NEXT_PUBLIC_AUTH_METHODS',
  'NEXT_PUBLIC_AUTH_PROVIDERS',
  'NEXT_PUBLIC_BILLING_ENABLED',
  'NEXT_PUBLIC_CONNECTORS_ENABLED',
  'NEXT_PUBLIC_GTM_ID',
  'NEXT_PUBLIC_KORTIX_ENV',
  'NEXT_PUBLIC_KORTIX_PERSONAL_CONTACT',
  'NEXT_PUBLIC_MANAGED_PROVIDER_ENABLED',
  'NEXT_PUBLIC_PHONE_NUMBER_MANDATORY',
  'NEXT_PUBLIC_SENTRY_DSN',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
];

const PREVIEW_DENIED_KEYS = new Set(['EDGE_CONFIG', 'EDGE_CONFIG_ID', 'VERCEL_API_TOKEN']);

function required(environment, key) {
  const value = environment[key];
  if (!value || value === '-') throw new Error(`${key} is required`);
  return value;
}

function requireUrl(value, expectedHost, key) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== expectedHost) {
    throw new Error(`${key} must target https://${expectedHost}`);
  }
  return value.replace(/\/$/, '');
}

export function renderWebEnvironment(name, environment = process.env) {
  const config = ENVIRONMENTS[name];
  if (!config) throw new Error(`unknown environment: ${name}`);

  requireUrl(
    required(environment, 'NEXT_PUBLIC_APP_URL'),
    config.canonicalHost,
    'NEXT_PUBLIC_APP_URL',
  );
  const appUrl = `https://${config.ecsHost}`;
  const backendUrl = requireUrl(
    required(environment, 'NEXT_PUBLIC_BACKEND_URL'),
    config.apiHost,
    'NEXT_PUBLIC_BACKEND_URL',
  );
  if (!backendUrl.endsWith('/v1')) {
    throw new Error('NEXT_PUBLIC_BACKEND_URL must end with /v1');
  }

  const payload = {
    NEXT_PUBLIC_APP_URL: appUrl,
    NEXT_PUBLIC_URL: appUrl,
    NEXT_PUBLIC_BACKEND_URL: backendUrl,
    NEXT_PUBLIC_SUPABASE_URL: required(environment, 'NEXT_PUBLIC_SUPABASE_URL'),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: required(environment, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    KORTIX_PUBLIC_APP_URL: appUrl,
    KORTIX_PUBLIC_BACKEND_URL: backendUrl,
    KORTIX_PUBLIC_SUPABASE_URL: required(environment, 'NEXT_PUBLIC_SUPABASE_URL'),
    KORTIX_PUBLIC_SUPABASE_ANON_KEY: required(environment, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    BACKEND_URL: backendUrl,
    SUPABASE_URL: required(environment, 'NEXT_PUBLIC_SUPABASE_URL'),
    SUPABASE_ANON_KEY: required(environment, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    WEB_PROTECTION_ENABLED: config.protected ? 'true' : 'false',
  };

  if (config.protected) {
    payload.WEB_PROTECTION_PASSWORD = required(environment, 'WEB_PROTECTION_PASSWORD');
  }

  const optionalKeys =
    name === 'preview'
      ? OPTIONAL_KEYS.filter((key) => !PREVIEW_DENIED_KEYS.has(key))
      : OPTIONAL_KEYS;
  for (const key of optionalKeys) {
    const value = environment[key];
    if (value && value !== '-') payload[key] = value;
  }
  return payload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = process.argv[2];
  process.stdout.write(JSON.stringify(renderWebEnvironment(name)));
}
