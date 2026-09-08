/**
 * `createKortixSession` — a session store for headless auth.
 *
 * Holds the `{access_token, refresh_token, expires_at}` a `kortix.auth.*` call
 * returned, persists it through an optional storage adapter (localStorage, a
 * file, a cookie jar, a DB row — anything with get/set/remove), refreshes it
 * through `/v1/auth/refresh` 60 s before it expires, and exposes `getToken`
 * for `createKortix`. One refresh at a time: concurrent callers share the
 * in-flight promise, so a rotating refresh token is never used twice.
 */
import { refreshSession, type AuthRequestOptions, type AuthSession, type AuthUser } from '../rest/platform-client/auth';

export interface KortixSessionStorage {
  get(): Promise<string | null> | string | null;
  set(value: string): Promise<void> | void;
  remove(): Promise<void> | void;
}

export interface KortixSessionOptions {
  storage?: KortixSessionStorage;
  /** Called after every change (sign-in, refresh, sign-out). */
  onChange?: (session: AuthSession | null) => void;
  /** Refresh this many seconds before expiry. Default 60. */
  refreshSkewSeconds?: number;
  /** Passed to `refreshSession`. */
  request?: AuthRequestOptions;
  /** Clock, for tests. */
  now?: () => number;
}

export interface KortixSession {
  /** The current session, or null. Does not refresh. */
  current(): AuthSession | null;
  /** Store a session a `kortix.auth.*` call returned. */
  set(session: AuthSession | null, user?: AuthUser | null): Promise<void>;
  /** The last user a `set` carried (not refreshed on rotation). */
  user(): AuthUser | null;
  /** A valid access token, refreshing first when needed; null when signed out. Wire to `createKortix({ getToken })`. */
  getToken(): Promise<string | null>;
  /** Force a rotation now. */
  refresh(): Promise<AuthSession | null>;
  /** Forget the session locally (call `kortix.auth.signOut` first to revoke it). */
  clear(): Promise<void>;
  /** Load from storage. Called lazily by the other methods; call it up front to hydrate eagerly. */
  load(): Promise<AuthSession | null>;
  /**
   * React to sign-in, refresh and sign-out. Returns an unsubscribe.
   *
   * The replacement for `supabase.auth.onAuthStateChange`. Distinct from the
   * `onChange` OPTION, which is a single slot fixed at construction: two
   * components both wanting to know would silently overwrite each other. This
   * fans out, and a listener that throws cannot take down its siblings or the
   * write that notified them.
   */
  subscribe(listener: (session: AuthSession | null) => void): () => void;
}

export function createKortixSession(options: KortixSessionOptions = {}): KortixSession {
  const skew = options.refreshSkewSeconds ?? 60;
  const now = options.now ?? (() => Date.now());
  let session: AuthSession | null = null;
  let user: AuthUser | null = null;
  let loaded = !options.storage;
  let inflight: Promise<AuthSession | null> | null = null;
  const listeners = new Set<(session: AuthSession | null) => void>();

  const expiresAt = (s: AuthSession) => (s.expires_at ?? 0) * 1000;
  const needsRefresh = (s: AuthSession) => expiresAt(s) - skew * 1000 <= now();

  async function persist(): Promise<void> {
    if (options.storage) {
      if (session) await options.storage.set(JSON.stringify({ session, user }));
      else await options.storage.remove();
    }
    // A listener is host code — a React setState, an analytics ping. One of
    // them throwing must not abort `persist`, or a UI bug becomes a failure to
    // save the session.
    for (const listener of [...listeners]) {
      try {
        listener(session);
      } catch {
        /* a broken listener is that listener's problem */
      }
    }
    try {
      options.onChange?.(session);
    } catch {
      /* same */
    }
  }

  async function load(): Promise<AuthSession | null> {
    if (loaded) return session;
    loaded = true;
    const raw = await options.storage!.get();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { session?: AuthSession; user?: AuthUser | null };
        if (parsed.session?.access_token && parsed.session?.refresh_token) {
          session = parsed.session;
          user = parsed.user ?? null;
        }
      } catch {
        session = null;
      }
    }
    return session;
  }

  async function refresh(): Promise<AuthSession | null> {
    await load();
    if (!session) return null;
    if (!inflight) {
      const token = session.refresh_token;
      inflight = refreshSession({ refresh_token: token }, options.request)
        .then(async (result) => {
          session = result.session;
          if (result.user) user = result.user;
          await persist();
          return session;
        })
        .catch(async (err) => {
          // A dead refresh token means signed out — everywhere. Anything else
          // (network) keeps the stored session so the next call can retry.
          const status = err && typeof err === 'object' && 'status' in err ? (err as { status: number }).status : 0;
          if (status >= 400 && status < 500) {
            session = null;
            user = null;
            await persist();
            return null;
          }
          throw err;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    current: () => session,
    user: () => user,
    load,
    async set(next, nextUser) {
      await load();
      session = next;
      if (nextUser !== undefined) user = nextUser;
      if (!next) user = null;
      await persist();
    },
    async getToken() {
      await load();
      if (!session) return null;
      if (needsRefresh(session)) {
        const refreshed = await refresh().catch(() => session);
        return refreshed?.access_token ?? null;
      }
      return session.access_token;
    },
    refresh,
    async clear() {
      session = null;
      user = null;
      loaded = true;
      await persist();
    },
  };
}
