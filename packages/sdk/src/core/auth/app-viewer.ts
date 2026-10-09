/**
 * Kortix Apps — the viewer, in the browser.
 *
 * An App hosted by Kortix is opened by someone who is ALREADY signed in to
 * Kortix: the Apps gate authenticated them before the App's first byte was
 * served. `GET /_kortix/viewer` on the App's own origin is the gate telling the
 * App who that is, and handing it a token scoped to (this viewer, this App).
 *
 * So a Kortix App needs no login of its own, no consent screen and no redirect:
 *
 * ```ts
 * const kortix = createKortix({
 *   backendUrl: '/_kortix/api/v1',
 *   getToken: kortixAppViewerToken(),
 * });
 * ```
 *
 * `/_kortix/api/v1/*` is the gate on the App's own origin. It forwards each
 * call to the Kortix API as the signed-in viewer, so the browser makes no
 * cross-origin request (the API answers no CORS preflight from an App origin).
 * It needs the App's `viewer_token_scope: 'api'`.
 *
 * The token is NOT the user's Kortix session: it expires in an hour, carries
 * only the scopes the App was granted (`profile email`, plus `kortix` when the
 * App is API-scoped), and dies with the App. This module caches it and refetches
 * shortly before it expires.
 *
 * For an App served on its own domain (not `*.apps.kortix.com`) there is no gate
 * — use `createKortixAuth` from `@kortix/sdk/server` instead.
 */

/** What the gate answers at `/_kortix/viewer`. */
export interface KortixAppViewerSession {
  app_id: string;
  access_mode: string;
  account_id: string;
  user_id: string;
  email: string | null;
  /** Display name from the viewer's profile. Absent from older gates. */
  name?: string | null;
  /** Profile picture URL. Absent from older gates. */
  picture?: string | null;
  group_ids: string[];
  /** Names of the same groups, unique within the account. Absent from older gates. */
  groups?: string[];
  /** The viewer's account role: `owner`, `admin` or `member`. Absent from older gates. */
  role?: string | null;
  /** The project that owns the App. Absent from older gates. */
  project_id?: string;
  scopes: string[];
  /** Bearer for the Kortix API, scoped to this viewer + App. Null when the App is identity-only. */
  access_token: string | null;
  expires_at: string | null;
}

export interface KortixAppViewerOptions {
  /** Where the gate answers. Default `/_kortix/viewer` (same origin). */
  path?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const DEFAULT_PATH = '/_kortix/viewer';
/** Refetch this long before expiry so a token handed to a caller is always live. */
const REFRESH_SKEW_MS = 60_000;

interface CacheEntry {
  session: KortixAppViewerSession | null;
  expiresAt: number;
  inflight?: Promise<KortixAppViewerSession | null>;
}

const cache = new Map<string, CacheEntry>();

/** Drop the cached viewer and sign-in tokens (sign-out, or an App that just changed who it acts as). */
export function clearKortixAppViewerCache(): void {
  cache.clear();
  appTokens.clear();
}

async function load(
  path: string,
  fetchImpl: NonNullable<KortixAppViewerOptions['fetch']>,
): Promise<KortixAppViewerSession | null> {
  let res: Response;
  try {
    res = await fetchImpl(path, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  } catch {
    return null;
  }
  // 401 = nobody signed in (a public or password App); 404 = this App was not
  // granted viewer identity. Both mean "no viewer", not "broken".
  if (res.status === 401 || res.status === 404) return null;
  if (!res.ok) return null;
  const session = (await res.json().catch(() => null)) as KortixAppViewerSession | null;
  return session && typeof session.user_id === 'string' ? session : null;
}

/**
 * The signed-in Kortix viewer of this App, or `null`. Cached until its token is
 * about to expire; concurrent callers share one request.
 */
export async function fetchKortixAppViewer(
  options: KortixAppViewerOptions = {},
): Promise<KortixAppViewerSession | null> {
  const path = options.path ?? DEFAULT_PATH;
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const entry = cache.get(path);
  if (entry && !entry.inflight && entry.expiresAt > Date.now()) return entry.session;
  if (entry?.inflight) return entry.inflight;

  const inflight = load(path, fetchImpl).then((session) => {
    const expiry = session?.expires_at ? Date.parse(session.expires_at) : Number.NaN;
    // No token (identity-only App) or an unparsable expiry: hold the answer for
    // a minute rather than asking the gate on every call.
    const expiresAt = Number.isFinite(expiry) ? expiry - REFRESH_SKEW_MS : Date.now() + REFRESH_SKEW_MS;
    cache.set(path, { session, expiresAt });
    return session;
  });
  cache.set(path, { session: entry?.session ?? null, expiresAt: 0, inflight });
  return inflight;
}

/**
 * A `getToken` for `createKortix` that authenticates as the App's viewer.
 * Yields `null` when nobody is signed in or the App is identity-only — the SDK
 * then makes unauthenticated calls rather than sending a naked bearer.
 */
export function kortixAppViewerToken(
  options: KortixAppViewerOptions = {},
): (() => Promise<string | null>) & { invalidate: (rejectedToken: string) => void } {
  const path = options.path ?? DEFAULT_PATH;
  return Object.assign(async () => (await fetchKortixAppViewer(options))?.access_token ?? null, {
    // The API refused this token: the gate revoked it (an access-policy save,
    // a consent revoke). Drop it so the transport's replay re-reads the gate.
    // Only when it is still the cached one — never drop a newer token.
    invalidate: (rejectedToken: string) => {
      const entry = cache.get(path);
      if (entry && !entry.inflight && entry.session?.access_token === rejectedToken) cache.delete(path);
    },
  });
}

// ── Sign-in tokens for Apps ──────────────────────────────────────────────────

export interface KortixTokenOptions {
  /**
   * The App the token is for, by slug or id: this App itself (the default) or
   * an App it uses (`uses`). Any other App answers `403 app_not_linked`.
   */
  audience?: string;
  /** Where the gate answers. Default `/_kortix/token` (same origin). */
  path?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/** A token fetcher: the shape realtime clients take as their auth callback. */
export type KortixTokenFetcher = (args?: { forceRefreshToken?: boolean }) => Promise<string | null>;

const appTokens = new Map<string, { token: string; refreshAt: number } | Promise<string | null>>();

async function loadAppToken(
  url: string,
  fetchImpl: NonNullable<KortixTokenOptions['fetch']>,
): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    // 401 nobody signed in, 403 an agent viewer or an App this App does not
    // use, 404 viewer identity off: all "no token", none of them a crash. The
    // unlinked App is a setup mistake the developer must see, so it warns.
    if (!res.ok) {
      if (res.status === 403) {
        const refusal = (await res.json().catch(() => null)) as { error?: unknown; error_description?: unknown } | null;
        if (refusal?.error === 'app_not_linked') console.warn(`[kortix] ${String(refusal.error_description)}`);
      }
      return null;
    }
    const body = (await res.json().catch(() => null)) as { token?: unknown; expires_at?: unknown } | null;
    if (!body || typeof body.token !== 'string') return null;
    const expiry = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN;
    appTokens.set(url, {
      token: body.token,
      refreshAt: Number.isFinite(expiry) ? expiry - REFRESH_SKEW_MS : Date.now() + REFRESH_SKEW_MS,
    });
    return body.token;
  } catch {
    return null;
  }
}

/**
 * A 15-minute Kortix sign-in token naming this App's viewer, from the App's
 * own origin. `aud` is the App the token is for; its server reads the viewer
 * with `verifyKortixToken`, or `readKortixMember` / `requireKortixMember` on
 * claims its runtime already verified.
 *
 * ```ts
 * const token = kortixToken();                    // for this App itself
 * client.setAuth(kortixToken({ audience: 'db' })); // for an App this App uses
 * ```
 *
 * Cached until shortly before expiry; concurrent callers share one request;
 * `{ forceRefreshToken: true }` always asks the gate again. Yields `null`
 * when there is no signed-in viewer, never throws. An App this App does not
 * use yields `null` and one console warning that names the fix.
 */
export function kortixToken(options: KortixTokenOptions = {}): KortixTokenFetcher {
  const base = options.path ?? '/_kortix/token';
  const url = options.audience === undefined ? base : `${base}?audience=${encodeURIComponent(options.audience)}`;
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  return async (args = {}) => {
    const entry = appTokens.get(url);
    if (entry instanceof Promise) return entry;
    if (entry && !args.forceRefreshToken && entry.refreshAt > Date.now()) return entry.token;
    const inflight = loadAppToken(url, fetchImpl).then((token) => {
      if (token === null) appTokens.delete(url);
      return token;
    });
    appTokens.set(url, inflight);
    return inflight;
  };
}

export interface KortixBindingOptions {
  /** This App's origin. Default: the page's `location.origin`. */
  origin?: string;
  fetch?: KortixTokenOptions['fetch'];
}

/** An App this App uses, reached through this App's own origin. */
export interface KortixBinding {
  /** `<origin>/_kortix/apps/<slug>`: the used App's endpoint, HTTP and WebSocket. */
  url: string;
  /** Sign-in tokens for the used App, naming this App's viewer. */
  token: KortixTokenFetcher;
}

/**
 * An App this App uses (`uses`), on this App's own origin: no cross-origin
 * request, no CORS. A used App whose kind has no endpoint answers
 * `409 app_binding_unsupported`; an App this App does not use answers
 * `403 app_not_linked`.
 *
 * ```ts
 * const db = kortixBinding('db');
 * const client = new ConvexReactClient(db.url);
 * client.setAuth(db.token);
 * ```
 */
export function kortixBinding(slug: string, options: KortixBindingOptions = {}): KortixBinding {
  const origin = options.origin ?? (globalThis as { location?: { origin?: string } }).location?.origin;
  if (!origin) throw new Error('kortixBinding needs the App origin: pass { origin } outside a browser.');
  return {
    url: `${origin.replace(/\/+$/, '')}/_kortix/apps/${encodeURIComponent(slug)}`,
    token: kortixToken({ audience: slug, fetch: options.fetch }),
  };
}
