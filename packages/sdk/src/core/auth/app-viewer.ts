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
 *   backendUrl: 'https://api.kortix.com/v1',
 *   getToken: kortixAppViewerToken(),
 * });
 * ```
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
  group_ids: string[];
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

/** Drop the cached viewer (sign-out, or an App that just changed who it acts as). */
export function clearKortixAppViewerCache(): void {
  cache.clear();
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
): () => Promise<string | null> {
  return async () => (await fetchKortixAppViewer(options))?.access_token ?? null;
}
