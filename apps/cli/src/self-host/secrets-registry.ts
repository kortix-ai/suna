// Single source of truth for every runtime secret the self-host `.env` holds:
// which service category it belongs to (for `kortix self-host secrets ls`),
// whether the CLI generates it or an operator supplies it, whether it can be
// rotated, and which Compose services actually consume it (so `secrets set`/
// `secrets rotate` can restart only what changed instead of the whole stack).
//
// Pure data + pure helpers only — no filesystem/process access — so this is
// trivially unit-testable and safely importable from both the `self-host`
// command and its tests without pulling in Docker/child_process.

export type SecretCategory =
  | 'database'
  | 'auth_email'
  | 'sandbox'
  | 'managed_git'
  | 'llm'
  | 'connectors'
  | 'reachability'
  | 'internal_tokens';

export const CATEGORY_ORDER: SecretCategory[] = [
  'database',
  'auth_email',
  'sandbox',
  'managed_git',
  'llm',
  'connectors',
  'reachability',
  'internal_tokens',
];

export const CATEGORY_LABELS: Record<SecretCategory, string> = {
  database: 'Database & Supabase',
  auth_email: 'Auth / Email / SMTP',
  sandbox: 'Agent sandbox',
  managed_git: 'Managed git',
  llm: 'LLM',
  connectors: 'Connectors',
  reachability: 'Reachability (Cloudflare tunnel)',
  internal_tokens: 'Internal tokens',
};

export interface SecretDef {
  key: string;
  category: SecretCategory;
  /** The CLI generates this value (crypto-random) vs. an operator supplies it. */
  kind: 'generated' | 'operator';
  /** Core functionality breaks/degrades without this set. */
  required: boolean;
  /** Eligible for `kortix self-host secrets rotate <KEY>` / `--all-generated`. */
  rotatable?: boolean;
}

/**
 * Every secret-ish key the self-host `.env` carries, grouped by the service
 * category it configures. Order within a category is display order.
 *
 * Deliberately excluded from `rotatable` even though they are `generated`:
 * SECRET_KEY_BASE, REALTIME_DB_ENC_KEY, VAULT_ENC_KEY, PG_META_CRYPTO_KEY,
 * LOGFLARE_*_ACCESS_TOKEN. These are internal Supabase-infra encryption keys —
 * rotating VAULT_ENC_KEY (Postgres pgsodium) or PG_META_CRYPTO_KEY would leave
 * already-encrypted data undecryptable, not just require a restart. They stay
 * out of `--all-generated` on purpose; nothing in this feature rotates them.
 */
export const SECRET_DEFS: SecretDef[] = [
  // Database & Supabase
  { key: 'POSTGRES_PASSWORD', category: 'database', kind: 'generated', required: true, rotatable: true },
  { key: 'SUPABASE_JWT_SECRET', category: 'database', kind: 'generated', required: true, rotatable: true },
  { key: 'SUPABASE_ANON_KEY', category: 'database', kind: 'generated', required: true, rotatable: false },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', category: 'database', kind: 'generated', required: true, rotatable: false },
  { key: 'DASHBOARD_USERNAME', category: 'database', kind: 'generated', required: true, rotatable: false },
  { key: 'DASHBOARD_PASSWORD', category: 'database', kind: 'generated', required: true, rotatable: true },
  { key: 'S3_PROTOCOL_ACCESS_KEY_ID', category: 'database', kind: 'generated', required: false, rotatable: true },
  { key: 'S3_PROTOCOL_ACCESS_KEY_SECRET', category: 'database', kind: 'generated', required: false, rotatable: true },

  // Auth / Email / SMTP
  { key: 'SMTP_HOST', category: 'auth_email', kind: 'operator', required: false },
  { key: 'SMTP_PORT', category: 'auth_email', kind: 'operator', required: false },
  { key: 'SMTP_USER', category: 'auth_email', kind: 'operator', required: false },
  { key: 'SMTP_PASS', category: 'auth_email', kind: 'operator', required: false },
  { key: 'SMTP_ADMIN_EMAIL', category: 'auth_email', kind: 'operator', required: false },
  { key: 'SMTP_SENDER_NAME', category: 'auth_email', kind: 'operator', required: false },
  // GoTrue SAML SSO signing key — generated once at `init` (samlPrivateKeyDer()
  // in commands/self-host.ts) so GOTRUE_SAML_ENABLED=true (the self-host
  // default) always has a key to boot with. `required: false` here on purpose:
  // defaultEnv() always populates it before the .env is ever written, so it is
  // never actually missing in a real instance — this just keeps it out of the
  // CLI's init-time blocking gate (missingRequiredSecrets), which is reserved
  // for secrets with no other way to get set. NOT rotatable: regenerating it
  // changes the SAML SP's signing identity and breaks every already-registered
  // IdP until re-registered.
  { key: 'SAML_PRIVATE_KEY', category: 'auth_email', kind: 'generated', required: false, rotatable: false },

  // Agent sandbox — three interchangeable providers (SandboxProviderName in
  // apps/api/src/config.ts). `init`/`configure` ask which ONE this instance
  // runs on (default daytona) and only collect that provider's key(s); the
  // actual required-secret gate is the composite sandboxProviderConfigured()
  // check in commands/self-host.ts (whichever provider ALLOWED_SANDBOX_
  // PROVIDERS names), not a blanket `required` flag per key here — Daytona
  // stays `required: true` below only because it's the default/recommended
  // provider, not because it's unconditionally needed.
  { key: 'DAYTONA_API_KEY', category: 'sandbox', kind: 'operator', required: true },
  { key: 'E2B_API_KEY', category: 'sandbox', kind: 'operator', required: false },
  { key: 'PLATINUM_API_KEY', category: 'sandbox', kind: 'operator', required: false },
  { key: 'PLATINUM_WEBHOOK_SECRET', category: 'sandbox', kind: 'operator', required: false },

  // Managed git — NOT init-required: configured in-app (Settings → Git,
  // DB-backed) after `start`, not by the CLI. See missingRequiredSecrets() in
  // commands/self-host.ts.
  { key: 'MANAGED_GIT_GITHUB_OWNER', category: 'managed_git', kind: 'operator', required: false },
  { key: 'MANAGED_GIT_GITHUB_TOKEN', category: 'managed_git', kind: 'operator', required: false },
  { key: 'MANAGED_GIT_GITHUB_INSTALL_ID', category: 'managed_git', kind: 'operator', required: false },
  { key: 'KORTIX_GITHUB_APP_ID', category: 'managed_git', kind: 'operator', required: false },
  { key: 'KORTIX_GITHUB_APP_PRIVATE_KEY', category: 'managed_git', kind: 'operator', required: false },
  { key: 'KORTIX_GITHUB_APP_SLUG', category: 'managed_git', kind: 'operator', required: false },
  // Minted alongside the App by `connect-github`'s manifest-conversion
  // exchange. Not read by the API today (installation-token auth doesn't need
  // them) — kept so the App can be managed/re-verified later without
  // regenerating it from scratch.
  { key: 'KORTIX_GITHUB_APP_CLIENT_ID', category: 'managed_git', kind: 'operator', required: false },
  { key: 'KORTIX_GITHUB_APP_CLIENT_SECRET', category: 'managed_git', kind: 'operator', required: false },
  { key: 'KORTIX_GITHUB_APP_WEBHOOK_SECRET', category: 'managed_git', kind: 'operator', required: false },
  // Signs the GitHub App install-state HMAC (buildGitHubAppInstallState in
  // apps/api/src/projects/github.ts). `connect-github` generates this once
  // (if unset) alongside the App credentials.
  { key: 'KORTIX_GITHUB_APP_STATE_SECRET', category: 'managed_git', kind: 'generated', required: false, rotatable: true },

  // LLM — NOT init-required: BYOK via the frontend's model picker after
  // `start`, not collected by the CLI.
  { key: 'OPENROUTER_API_KEY', category: 'llm', kind: 'operator', required: false },
  { key: 'AWS_BEDROCK_API_KEY', category: 'llm', kind: 'operator', required: false },
  { key: 'AWS_BEDROCK_REGION', category: 'llm', kind: 'operator', required: false },

  // Connectors
  { key: 'PIPEDREAM_CLIENT_ID', category: 'connectors', kind: 'operator', required: false },
  { key: 'PIPEDREAM_CLIENT_SECRET', category: 'connectors', kind: 'operator', required: false },
  { key: 'PIPEDREAM_PROJECT_ID', category: 'connectors', kind: 'operator', required: false },
  { key: 'PIPEDREAM_WEBHOOK_SECRET', category: 'connectors', kind: 'operator', required: false },

  // Reachability (tunnel mode only — see self-host/tunnel.ts). Both optional:
  // absent, the `cloudflared` service runs a free zero-config quick tunnel
  // whose URL is ephemeral (re-captured on every start/update). Setting both
  // switches to a stable named tunnel instead.
  { key: 'CLOUDFLARE_TUNNEL_TOKEN', category: 'reachability', kind: 'operator', required: false },
  { key: 'CLOUDFLARE_TUNNEL_HOSTNAME', category: 'reachability', kind: 'operator', required: false },

  // Internal tokens
  { key: 'GATEWAY_INTERNAL_TOKEN', category: 'internal_tokens', kind: 'generated', required: true, rotatable: true },
  { key: 'INTERNAL_SERVICE_KEY', category: 'internal_tokens', kind: 'generated', required: true, rotatable: true },
  { key: 'API_KEY_SECRET', category: 'internal_tokens', kind: 'generated', required: true, rotatable: true },
  { key: 'TUNNEL_SIGNING_SECRET', category: 'internal_tokens', kind: 'generated', required: true, rotatable: true },
];

const SECRET_DEF_BY_KEY: ReadonlyMap<string, SecretDef> = new Map(
  SECRET_DEFS.map((def) => [def.key, def]),
);

export function secretDefFor(key: string): SecretDef | undefined {
  return SECRET_DEF_BY_KEY.get(key);
}

/** Keys eligible for `secrets rotate --all-generated`, in a stable order. */
export const ROTATABLE_GENERATED_KEYS: string[] = SECRET_DEFS.filter(
  (def) => def.kind === 'generated' && def.rotatable,
).map((def) => def.key);

/**
 * Runtime keys the auto-updater/`init` recompute on every run (image tags,
 * the tracked version, the replica count derived from KORTIX_DOMAIN). They
 * are not independent settings — hand-setting one is silently clobbered by
 * the next `init`/`update`/`configure`, which is confusing rather than
 * useful — so both `env set` and `secrets set` refuse to touch them.
 * Use `--tag`/`--channel`/`--release` (which drive these) instead.
 */
export const UPDATER_MANAGED_RUNTIME_KEYS: ReadonlySet<string> = new Set([
  'KORTIX_VERSION',
  'FRONTEND_IMAGE',
  'API_IMAGE',
  'GATEWAY_IMAGE',
  'SANDBOX_IMAGE',
  'KORTIX_APP_REPLICAS',
]);

export function isUpdaterManagedKey(key: string): boolean {
  return UPDATER_MANAGED_RUNTIME_KEYS.has(key);
}

/**
 * Key → Compose service names it configures, the single source of truth used
 * by both `secrets set` (restart only what a changed key affects) and
 * `secrets ls` (nothing reads this directly, but keeping one map means the
 * restart behavior can never drift from the docs). Unlisted keys default to
 * ['kortix-api'] in `servicesForKeys` below — kortix-api loads every `.env`
 * key via `env_file:` (see kortix-compose.yml), so it is always a safe,
 * conservative default for anything not explicitly mapped.
 */
export const KEY_SERVICE_MAP: Record<string, readonly string[]> = {
  // Database & Supabase
  POSTGRES_PASSWORD: [
    'supabase-db', 'supabase-auth', 'supabase-rest', 'supabase-realtime',
    'supabase-storage', 'supabase-meta', 'supabase-functions', 'supabase-supavisor',
    'supabase-analytics', 'kortix-api',
  ],
  SUPABASE_JWT_SECRET: [
    'supabase-db', 'supabase-kong', 'supabase-auth', 'supabase-rest', 'supabase-realtime',
    'supabase-storage', 'supabase-meta', 'supabase-functions', 'supabase-analytics',
    'kortix-api', 'frontend',
  ],
  SUPABASE_ANON_KEY: ['supabase-kong', 'supabase-realtime', 'supabase-storage', 'supabase-meta', 'supabase-functions', 'frontend', 'kortix-api'],
  SUPABASE_SERVICE_ROLE_KEY: ['supabase-kong', 'supabase-realtime', 'supabase-storage', 'supabase-meta', 'supabase-functions', 'kortix-api'],
  DASHBOARD_USERNAME: ['supabase-kong'],
  DASHBOARD_PASSWORD: ['supabase-kong'],
  S3_PROTOCOL_ACCESS_KEY_ID: ['supabase-storage'],
  S3_PROTOCOL_ACCESS_KEY_SECRET: ['supabase-storage'],

  // Auth / Email / SMTP — all consumed by GoTrue only.
  SMTP_HOST: ['supabase-auth'],
  SMTP_PORT: ['supabase-auth'],
  SMTP_USER: ['supabase-auth'],
  SMTP_PASS: ['supabase-auth'],
  SMTP_ADMIN_EMAIL: ['supabase-auth'],
  SMTP_SENDER_NAME: ['supabase-auth'],
  SAML_PRIVATE_KEY: ['supabase-auth'],

  // Agent sandbox — all three interchangeable providers
  DAYTONA_API_KEY: ['kortix-api'],
  DAYTONA_SERVER_URL: ['kortix-api'],
  DAYTONA_TARGET: ['kortix-api'],
  E2B_API_KEY: ['kortix-api'],
  PLATINUM_API_KEY: ['kortix-api'],
  PLATINUM_API_URL: ['kortix-api'],
  PLATINUM_TEMPLATE: ['kortix-api'],
  PLATINUM_WEBHOOK_SECRET: ['kortix-api'],

  // Managed git
  MANAGED_GIT_GITHUB_OWNER: ['kortix-api'],
  MANAGED_GIT_GITHUB_TOKEN: ['kortix-api'],
  MANAGED_GIT_GITHUB_INSTALL_ID: ['kortix-api'],
  KORTIX_GITHUB_APP_ID: ['kortix-api'],
  KORTIX_GITHUB_APP_PRIVATE_KEY: ['kortix-api'],
  KORTIX_GITHUB_APP_SLUG: ['kortix-api'],
  KORTIX_GITHUB_APP_CLIENT_ID: ['kortix-api'],
  KORTIX_GITHUB_APP_CLIENT_SECRET: ['kortix-api'],
  KORTIX_GITHUB_APP_WEBHOOK_SECRET: ['kortix-api'],
  KORTIX_GITHUB_APP_STATE_SECRET: ['kortix-api'],
  KORTIX_GITHUB_TOKEN: ['kortix-api'],
  KORTIX_GITHUB_OWNER: ['kortix-api'],

  // LLM
  OPENROUTER_API_KEY: ['kortix-api'],
  AWS_BEDROCK_API_KEY: ['kortix-api'],
  AWS_BEDROCK_REGION: ['kortix-api'],

  // Connectors
  PIPEDREAM_CLIENT_ID: ['kortix-api'],
  PIPEDREAM_CLIENT_SECRET: ['kortix-api'],
  PIPEDREAM_PROJECT_ID: ['kortix-api'],
  PIPEDREAM_ENVIRONMENT: ['kortix-api'],
  PIPEDREAM_WEBHOOK_SECRET: ['kortix-api'],

  // Reachability
  CLOUDFLARE_TUNNEL_TOKEN: ['cloudflared'],
  CLOUDFLARE_TUNNEL_HOSTNAME: ['cloudflared'],

  // Internal tokens
  GATEWAY_INTERNAL_TOKEN: ['kortix-api', 'llm-gateway'],
  INTERNAL_SERVICE_KEY: ['kortix-api'],
  API_KEY_SECRET: ['kortix-api'],
  TUNNEL_SIGNING_SECRET: ['kortix-api'],
};

/** Safe fallback for any key not explicitly mapped above. */
const DEFAULT_SERVICES: readonly string[] = ['kortix-api'];

/** Union of the services a set of changed keys affects, sorted + deduped. */
export function servicesForKeys(keys: readonly string[]): string[] {
  const set = new Set<string>();
  for (const key of keys) {
    const services = KEY_SERVICE_MAP[key] ?? DEFAULT_SERVICES;
    for (const service of services) set.add(service);
  }
  return [...set].sort();
}

/** Show enough of a secret to recognize it without revealing it: first 3 +
 *  last 4 characters for anything long enough to make that safe, otherwise a
 *  fixed-width mask. Empty input stays empty (an unset secret, not a masked one). */
export function maskSecretValue(value: string): string {
  if (!value) return '';
  if (value.length <= 10) return '•'.repeat(Math.max(4, Math.min(8, value.length)));
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

export interface SecretRow {
  key: string;
  category: SecretCategory;
  kind: 'generated' | 'operator';
  required: boolean;
  rotatable: boolean;
  configured: boolean;
  masked: string;
  updaterManaged: boolean;
}

export interface SecretCategoryGroup {
  category: SecretCategory;
  label: string;
  rows: SecretRow[];
}

/** Group every declared secret by category against a live env snapshot, for
 *  `kortix self-host secrets ls`. Preserves CATEGORY_ORDER / SECRET_DEFS order. */
export function groupSecretsByCategory(env: Record<string, string>): SecretCategoryGroup[] {
  const byCategory = new Map<SecretCategory, SecretRow[]>();
  for (const category of CATEGORY_ORDER) byCategory.set(category, []);

  for (const def of SECRET_DEFS) {
    const value = env[def.key] ?? '';
    byCategory.get(def.category)!.push({
      key: def.key,
      category: def.category,
      kind: def.kind,
      required: def.required,
      rotatable: Boolean(def.rotatable),
      configured: value.trim() !== '',
      masked: maskSecretValue(value),
      updaterManaged: isUpdaterManagedKey(def.key),
    });
  }

  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    rows: byCategory.get(category)!,
  }));
}
