/**
 * Self-hosted instances: which Kortix the app signs in to and talks to.
 *
 * A deployment is the web origin a user already opens in a browser or in the
 * desktop app (the same URL the desktop instance chooser takes), or its API
 * URL. For a web origin the app reads its public runtime config
 * (`GET /api/runtime-config`, served by apps/web from the same env as its own
 * auth page) for the API URL, the Supabase URL + anon key and the auth
 * methods. For an API URL (`api.kortix.com`, `…/v1`, a LAN `:8008`) it reads
 * the API's public `GET /v1/auth/client-config` instead: a web app behind
 * access protection (dev, staging) cannot be read from a phone, its API can.
 *
 * Pure: no React Native, no storage. `store.ts` persists the choice.
 */

export interface Deployment {
  /** Origin the user entered (web or API), e.g. `https://kortix.example.com`. */
  origin: string;
  /** Web origin for "open on the web" links: the entered web origin, or the API's `frontend_url`. */
  webUrl: string;
  /** API base, always ending in `/v1`. */
  backendUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** Raw `AUTH_METHODS` / `AUTH_PROVIDERS` of the deployment (comma lists); null = not reported, use the build defaults. */
  authMethods: string | null;
  authProviders: string | null;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const KORTIX_CLOUD_WEB_URL = 'https://kortix.com';
/** The self-hosting guide (`apps/web/content/docs/host/index.mdx`), behind the sheet's Docs button. */
export const SELF_HOST_DOCS_URL = `${KORTIX_CLOUD_WEB_URL}/docs/host`;
const DEFAULT_BACKEND_URL = 'http://localhost:8008/v1';
const PROBE_TIMEOUT_MS = 8_000;

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function isLoopbackHost(hostname: string): boolean {
  const h = bareHost(hostname);
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Loopback, RFC 1918 or mDNS: the only hosts plain http is accepted for (local development). */
function isPrivateHost(hostname: string): boolean {
  const h = bareHost(hostname);
  if (isLoopbackHost(h) || h.endsWith('.local')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function isAllowedUrl(url: URL): boolean {
  if (url.username || url.password) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && isPrivateHost(url.hostname));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What the user typed → the deployment origin. Mirrors apps/desktop-electron instance-rules.js. */
export function normalizeDeploymentUrl(raw: unknown): { ok: true; origin: string } | { ok: false; error: string } {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) return { ok: false, error: 'Enter the URL of your Kortix instance.' };

  // `localhost:3000` parses as the scheme `localhost:`; a host:port prefix is a bare host.
  const isHostPort = /^[^\s/:]+:\d+(?:[/?#]|$)/.test(input);
  const hasScheme = !isHostPort && /^[a-z][a-z0-9+.-]*:/i.test(input);
  let candidate = input;
  if (!hasScheme) {
    const host = input.startsWith('[') ? input.slice(0, input.indexOf(']') + 1) : input.split(/[/:?#]/)[0];
    candidate = `${isPrivateHost(host) ? 'http' : 'https'}://${input}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: 'This is not a valid address.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'The address must start with https://.' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Remove the username and password from the address.' };
  }
  if (!url.hostname) return { ok: false, error: 'This is not a valid address.' };
  if (!isAllowedUrl(url)) {
    return { ok: false, error: 'Use https://. Plain http:// works only for a local network address.' };
  }
  return { ok: true, origin: url.origin };
}

/**
 * Resolve one URL of the runtime config against the deployment: a relative
 * value (`/supabase`) is on the origin, and a loopback host (a local stack's
 * `localhost:8008`) is the machine the user entered. Null when unusable.
 */
function resolveConfigUrl(value: unknown, origin: string): URL | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim(), origin);
  } catch {
    return null;
  }
  const base = new URL(origin);
  if (isLoopbackHost(url.hostname) && !isLoopbackHost(base.hostname)) url.hostname = base.hostname;
  return isAllowedUrl(url) ? url : null;
}

function withoutTrailingSlash(url: URL): string {
  return url.toString().replace(/\/+$/, '');
}

const RUNTIME_CONFIG = /__KORTIX_RUNTIME_CONFIG=(\{[\s\S]*?\});\s*window\.__RUNTIME_ENV/;

export function parseRuntimeConfig(
  script: string,
  origin: string
): { ok: true; deployment: Deployment } | { ok: false; error: string } {
  const host = hostOf(origin);
  const notKortix = { ok: false as const, error: `${host} is not a Kortix instance.` };
  const match = RUNTIME_CONFIG.exec(script);
  if (!match) return notKortix;
  let env: Record<string, unknown>;
  try {
    env = JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return notKortix;
  }

  const anonKey = typeof env.SUPABASE_ANON_KEY === 'string' ? env.SUPABASE_ANON_KEY.trim() : '';
  if (!anonKey || !env.SUPABASE_URL || !env.BACKEND_URL) {
    return { ok: false, error: `${host} has no sign-in configuration.` };
  }
  const supabaseUrl = resolveConfigUrl(env.SUPABASE_URL, origin);
  const backendUrl = resolveConfigUrl(env.BACKEND_URL, origin);
  if (!supabaseUrl || !backendUrl) {
    return { ok: false, error: `${host} points sign-in at an insecure or invalid address.` };
  }
  const api = withoutTrailingSlash(backendUrl);
  return {
    ok: true,
    deployment: {
      origin,
      webUrl: origin,
      backendUrl: api.endsWith('/v1') ? api : `${api}/v1`,
      supabaseUrl: withoutTrailingSlash(supabaseUrl),
      supabaseAnonKey: anonKey,
      authMethods: typeof env.AUTH_METHODS === 'string' ? env.AUTH_METHODS : '',
      authProviders: typeof env.AUTH_PROVIDERS === 'string' ? env.AUTH_PROVIDERS : '',
    },
  };
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${hostOf(url)} did not respond within ${PROBE_TIMEOUT_MS / 1000} s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

type CheckResult = { ok: true; deployment: Deployment } | { ok: false; error: string };

function listOrNull(value: unknown): string | null {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string').join(',') : null;
}

/**
 * The host is no web app: read the API's public client config
 * (`GET /v1/auth/client-config`, apps/api/src/http/auth/headless.ts). An API that
 * has no anon key configured names its web app; that web app's runtime config
 * is the fallback.
 */
async function readApiConfig(origin: string, webStatus: number, fetchImpl: FetchLike): Promise<CheckResult> {
  const host = hostOf(origin);
  const res = await fetchWithTimeout(fetchImpl, `${origin}/v1/auth/client-config`).catch(() => null);
  const config = res?.ok ? ((await res.json().catch(() => null)) as Record<string, unknown> | null) : null;
  if (!config || typeof config.supabase_url !== 'string') {
    const isApi = await fetchWithTimeout(fetchImpl, `${origin}/v1/health`).then(
      (health) => health.ok,
      () => false
    );
    return {
      ok: false,
      error: isApi
        ? `${host} runs an older Kortix API. Enter the web URL, or update the instance.`
        : `${host} is not a Kortix instance (HTTP ${webStatus}).`,
    };
  }

  const web = resolveConfigUrl(config.frontend_url, origin)?.origin ?? null;
  const anonKey = typeof config.supabase_anon_key === 'string' ? config.supabase_anon_key.trim() : '';
  if (!anonKey) {
    const noConfig = `${host} has no sign-in configuration`;
    if (!web) return { ok: false, error: `${noConfig}.` };
    const page = await fetchWithTimeout(fetchImpl, `${web}/api/runtime-config`, {
      headers: { accept: 'application/javascript' },
    }).catch(() => null);
    const script = page?.ok ? await page.text().catch(() => '') : '';
    if (!RUNTIME_CONFIG.test(script)) return { ok: false, error: `${noConfig}, and ${hostOf(web)} did not provide one.` };
    const parsed = parseRuntimeConfig(script, web);
    return parsed.ok ? { ok: true, deployment: { ...parsed.deployment, origin } } : parsed;
  }

  const supabaseUrl = resolveConfigUrl(config.supabase_url, origin);
  if (!supabaseUrl) return { ok: false, error: `${host} points sign-in at an insecure or invalid address.` };
  return {
    ok: true,
    deployment: {
      origin,
      webUrl: web ?? origin,
      backendUrl: `${origin}/v1`,
      supabaseUrl: withoutTrailingSlash(supabaseUrl),
      supabaseAnonKey: anonKey,
      authMethods: listOrNull(config.auth_methods),
      authProviders: listOrNull(config.auth_providers),
    },
  };
}

/**
 * Validate what the user entered before anything is saved: the origin serves
 * the Kortix web runtime config or the API client config, and the API it
 * names answers `/v1/health` (any HTTP status proves the server is reachable).
 */
export async function checkDeployment(raw: unknown, fetchImpl: FetchLike): Promise<CheckResult> {
  const normalized = normalizeDeploymentUrl(raw);
  if (!normalized.ok) return normalized;
  const { origin } = normalized;
  const host = hostOf(origin);

  let res: Response;
  let script: string;
  try {
    res = await fetchWithTimeout(fetchImpl, `${origin}/api/runtime-config`, {
      headers: { accept: 'application/javascript' },
    });
    script = res.ok ? await res.text() : '';
  } catch (error) {
    const message = (error as Error)?.message ?? '';
    return { ok: false, error: message.includes('did not respond') ? message : `${host} could not be reached.` };
  }

  const parsed = RUNTIME_CONFIG.test(script)
    ? parseRuntimeConfig(script, origin)
    : await readApiConfig(origin, res.status, fetchImpl);
  if (!parsed.ok) return parsed;

  try {
    await fetchWithTimeout(fetchImpl, `${parsed.deployment.backendUrl}/health`);
  } catch {
    return {
      ok: false,
      error: `The API of this instance (${hostOf(parsed.deployment.backendUrl)}) could not be reached.`,
    };
  }
  return parsed;
}

/** Same signal the web auth page uses for its SSO button: GoTrue's public `saml_enabled`. */
export async function fetchSsoEnabled(deployment: Deployment, fetchImpl: FetchLike): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(fetchImpl, `${deployment.supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: deployment.supabaseAnonKey },
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { saml_enabled?: unknown };
    return body?.saml_enabled === true;
  } catch {
    return false;
  }
}

/** The saved choice, re-validated: a corrupt or tampered file means the build default. */
export function parseSavedDeployment(raw: string | null | undefined): Deployment | null {
  if (!raw) return null;
  let value: Partial<Record<keyof Deployment, unknown>>;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const fields = ['origin', 'backendUrl', 'supabaseUrl', 'supabaseAnonKey'] as const;
  if (!value || fields.some((key) => typeof value[key] !== 'string')) return null;
  const lists = ['authMethods', 'authProviders'] as const;
  if (lists.some((key) => typeof value[key] !== 'string' && value[key] !== null)) return null;
  const d = value as Deployment;
  const origin = normalizeDeploymentUrl(d.origin);
  if (!origin.ok || origin.origin !== d.origin || !d.supabaseAnonKey) return null;
  // Saved before `webUrl` existed: the origin was always the web origin.
  const webUrl = typeof d.webUrl === 'string' ? d.webUrl : d.origin;
  for (const url of [webUrl, d.backendUrl, d.supabaseUrl]) {
    try {
      if (!isAllowedUrl(new URL(url))) return null;
    } catch {
      return null;
    }
  }
  return {
    origin: d.origin,
    webUrl,
    backendUrl: d.backendUrl,
    supabaseUrl: d.supabaseUrl,
    supabaseAnonKey: d.supabaseAnonKey,
    authMethods: d.authMethods,
    authProviders: d.authProviders,
  };
}

/**
 * Build-time values. Callers pass `process.env.EXPO_PUBLIC_*` member by
 * member: Expo inlines only literal `process.env.EXPO_PUBLIC_X` reads.
 */
export interface BuildEnv {
  EXPO_PUBLIC_BACKEND_URL?: string;
  EXPO_PUBLIC_SUPABASE_URL?: string;
  EXPO_PUBLIC_SUPABASE_ANON_KEY?: string;
  EXPO_PUBLIC_AUTH_METHODS?: string;
}

/** Every endpoint the app uses, from one place: the saved deployment, else the build. */
export function resolveEndpoints(deployment: Deployment | null, env: BuildEnv) {
  if (deployment) {
    return {
      backendUrl: deployment.backendUrl,
      supabaseUrl: deployment.supabaseUrl,
      supabaseAnonKey: deployment.supabaseAnonKey,
      webUrl: deployment.webUrl,
    };
  }
  return {
    backendUrl: env.EXPO_PUBLIC_BACKEND_URL || DEFAULT_BACKEND_URL,
    supabaseUrl: env.EXPO_PUBLIC_SUPABASE_URL ?? '',
    supabaseAnonKey: env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
    // Always kortix.com for the build default (lib/kortix-web.ts).
    webUrl: KORTIX_CLOUD_WEB_URL,
  };
}

function parseList(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Which sign-in options the auth screens render. The build default keeps the
 * shipped behavior (Google + Apple always, email methods from
 * `EXPO_PUBLIC_AUTH_METHODS`). A self-hosted instance renders exactly what its
 * web auth page renders (`AUTH_METHODS` / `AUTH_PROVIDERS`); a list the
 * instance does not report (null, an API without the setting) keeps the
 * build default.
 */
export function authOptionsFor(deployment: Deployment | null, env: BuildEnv) {
  const methods = parseList(deployment?.authMethods ?? env.EXPO_PUBLIC_AUTH_METHODS).filter(
    (m) => m === 'magic' || m === 'password'
  );
  const both = methods.length === 0;
  const reported = deployment?.authProviders ?? null;
  const providers = parseList(reported);
  return {
    magic: both || methods.includes('magic'),
    password: both || methods.includes('password'),
    google: reported === null || providers.includes('google'),
    apple: reported === null || providers.includes('apple'),
    custom: deployment !== null,
  };
}
