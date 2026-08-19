/**
 * `createKortixAuth` — a token PRODUCER that sits in front of the one auth
 * seam, never a second transport.
 *
 * ```ts
 * const auth   = createKortixAuth({ backendUrl });
 * const kortix = createKortix({ backendUrl, getToken: auth.getToken });
 * ```
 *
 * Its entire outbound surface is GoTrue (`/auth/v1/*`, authorized by the
 * public anon key) plus ONE unauthenticated Kortix call, `GET /v1/auth/config`.
 * It never calls `authenticatedFetch`, never calls `backendApi`, never resolves
 * a session runtime, and never calls `configureKortix` — a global side effect
 * at construction would break `createScopedKortix`'s per-request isolation.
 *
 * The caching, single-flight, and refresh semantics are a behaviour-preserving
 * port of `apps/web/src/lib/auth-token.ts`, including its documented fix: a
 * stored-but-expired `access_token` is REFRESHED, never handed out.
 *
 * No timers. Refresh is lazy and driven by `getToken`, so the module is inert
 * in a worker, a lambda, and a test — and there is no `dispose()` to forget.
 */

import { base64UrlEncode } from './base64';
import { fetchKortixAuthConfig, type KortixAuthConfig, type KortixAuthMethod } from './config';
import { KortixAuthError, type AuthFetch } from './errors';
import {
  gotrueAuthorizeUrl,
  gotrueExchangeCodeForSession,
  gotrueGetUser,
  gotrueRefreshSession,
  gotrueSignInWithOtp,
  gotrueSignInWithPassword,
  gotrueSignOut,
  gotrueVerifyOtp,
  type GoTrueContext,
  type KortixSignOutScope,
  type KortixVerifyOtpType,
} from './gotrue';
import {
  DEFAULT_EXPIRY_SKEW_SECONDS,
  isJwtExpired,
  type KortixAuthSession,
  type KortixAuthUser,
} from './session';
import {
  DEFAULT_STORAGE_KEY,
  parseStoredSession,
  resolveAuthStorage,
  serializeStoredSession,
  type KortixAuthStorage,
} from './storage';

/** In-memory reuse window for a resolved token (`auth-token.ts:31`). */
const TOKEN_CACHE_TTL_MS = 30_000;
/** Retries after a NETWORK failure — not after a server rejection (`:27`). */
const TOKEN_MAX_RETRIES = 2;
/** First retry delay; doubles each attempt → 300, 600 (`:29`). */
const TOKEN_RETRY_BASE_DELAY_MS = 300;

/** Auth state transitions. Names mirror GoTrue's `onAuthStateChange` so a host
 *  migrating off supabase-js keeps its `switch` unchanged. */
export type KortixAuthEvent =
  | 'INITIAL'
  | 'SIGNED_IN'
  | 'SIGNED_OUT'
  | 'TOKEN_REFRESHED'
  | 'USER_UPDATED';

export interface KortixAuthChange {
  event: KortixAuthEvent;
  session: KortixAuthSession | null;
}

export interface KortixAuthOptions {
  /** Kortix API base. Both `https://api.kortix.com` and `.../v1` are valid. */
  backendUrl: string;
  /** Skip discovery entirely — a self-host with known values, or a test. */
  config?: KortixAuthConfig;
  storage?: KortixAuthStorage;
  /** Default `'kortix.auth.session'`. The PKCE verifier lives at `<key>.verifier`. */
  storageKey?: string;
  fetch?: AuthFetch;
  /** Seconds before `exp` a token counts as expired. Default 30. */
  expirySkewSeconds?: number;
  /** In-memory reuse period, in ms. Default 30_000, from apps/web. */
  tokenCacheTtlMs?: number;
  onError?: (error: unknown, context?: unknown) => void;
  /** Browser-only, opt-in. Default false — the core may never assume a browser. */
  syncAcrossTabs?: boolean;
}

export interface KortixAuth {
  /** The seam. NEVER throws; `null` means "no usable token". */
  getToken(): Promise<string | null>;
  signInWithPassword(input: { email: string; password: string }): Promise<KortixAuthSession>;
  /** Sends the email. Resolves `void` — no session exists yet. */
  signInWithOtp(input: {
    email: string;
    redirectTo?: string;
    shouldCreateUser?: boolean;
    data?: Record<string, unknown>;
  }): Promise<void>;
  verifyOtp(input: { email: string; token: string; type?: KortixVerifyOtpType }): Promise<KortixAuthSession>;
  signOut(options?: { scope?: 'global' | 'local' | 'others' }): Promise<void>;
  /** Cached with the session; `force` re-reads from GoTrue. */
  getUser(options?: { force?: boolean }): Promise<KortixAuthUser | null>;
  /** Force a refresh regardless of TTL. `null` when there is nothing to refresh. */
  refresh(): Promise<KortixAuthSession | null>;
  onChange(listener: (change: KortixAuthChange) => void): () => void;
  /** Synchronous read — a host cannot render an auth gate off a Promise. */
  getSession(): KortixAuthSession | null;
  /** The memoized discovery result. Hosts need `methods`/`providers` to render a login form. */
  config(): Promise<KortixAuthConfig>;
  /** PKCE authorize URL. Builds the URL only — it never navigates. */
  authorizeUrl(provider: string, options?: { redirectTo?: string; scopes?: string }): Promise<string>;
  exchangeCodeForSession(code: string): Promise<KortixAuthSession>;
}

/** Injectable internals. NOT part of the public surface — `client.test.ts`
 *  uses it to assert the exact retry delays without a wall-clock sleep. */
export interface KortixAuthInternalDeps {
  sleep?: (ms: number) => Promise<void>;
}

export function createKortixAuth(options: KortixAuthOptions): KortixAuth {
  return createKortixAuthWithDeps(options, {});
}

export function createKortixAuthWithDeps(
  options: KortixAuthOptions,
  deps: KortixAuthInternalDeps,
): KortixAuth {
  const storage = resolveAuthStorage(options.storage);
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const verifierKey = `${storageKey}.verifier`;
  const skewSeconds = options.expirySkewSeconds ?? DEFAULT_EXPIRY_SKEW_SECONDS;
  const cacheTtlMs = options.tokenCacheTtlMs ?? TOKEN_CACHE_TTL_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const fetchImpl: AuthFetch = (input, init) =>
    options.fetch ? options.fetch(input, init) : globalThis.fetch(input, init);

  let configPromise: Promise<KortixAuthConfig> | null = null;
  let hydration: Promise<void> | null = null;
  let session: KortixAuthSession | null = null;
  let cachedToken: string | null = null;
  let cachedAt = 0;
  let inflight: Promise<string | null> | null = null;
  const listeners = new Set<(change: KortixAuthChange) => void>();

  function report(error: unknown, context?: unknown): void {
    try {
      options.onError?.(error, context);
    } catch {
      // An onError that itself throws must not take the caller down with it.
    }
  }

  function deliver(listener: (change: KortixAuthChange) => void, change: KortixAuthChange): void {
    try {
      listener(change);
    } catch (error) {
      // One bad listener must not break token refresh for everything else.
      report(error, { event: change.event });
    }
  }

  function emit(event: KortixAuthEvent): void {
    const change: KortixAuthChange = { event, session };
    for (const listener of listeners) deliver(listener, change);
  }

  function loadConfig(): Promise<KortixAuthConfig> {
    if (!configPromise) {
      configPromise = options.config
        ? Promise.resolve(options.config)
        : fetchKortixAuthConfig({ backendUrl: options.backendUrl, fetch: fetchImpl }).catch(
            (error: unknown) => {
              // Do not memoize a failure: a deployment that was mid-rollout must
              // be re-askable on the next call.
              configPromise = null;
              throw error;
            },
          );
    }
    return configPromise;
  }

  async function gotrueContext(): Promise<GoTrueContext> {
    const config = await loadConfig();
    return { url: config.url, anonKey: config.anonKey, fetch: fetchImpl };
  }

  /** Read the persisted session once. The blob is URL-stamped, so discovery
   *  must resolve first — that check is what makes one browser profile driving
   *  two backends structurally safe. */
  function ensureHydrated(): Promise<void> {
    if (!hydration) {
      hydration = (async () => {
        const config = await loadConfig();
        const raw = await storage.getItem(storageKey);
        session = parseStoredSession(raw ?? null, config.url);
      })().catch((error: unknown) => {
        hydration = null;
        throw error;
      });
    }
    return hydration;
  }

  async function persist(next: KortixAuthSession): Promise<void> {
    const config = await loadConfig();
    session = next;
    cachedToken = next.access_token;
    cachedAt = Date.now();
    await storage.setItem(storageKey, serializeStoredSession(config.url, next));
  }

  async function clear(): Promise<void> {
    session = null;
    cachedToken = null;
    cachedAt = 0;
    await storage.removeItem(storageKey);
  }

  /** A 400/401 is the server saying the refresh token is dead — sign out. Any
   *  other failure (a thrown fetch, a 5xx) is the network saying nothing, and a
   *  flaky network must never sign a user out. */
  function isRejection(error: unknown): boolean {
    return error instanceof KortixAuthError && (error.status === 400 || error.status === 401);
  }

  async function refreshWithRetries(refreshToken: string): Promise<KortixAuthSession | 'rejected' | null> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= TOKEN_MAX_RETRIES; attempt++) {
      try {
        const ctx = await gotrueContext();
        return await gotrueRefreshSession(ctx, refreshToken);
      } catch (error) {
        if (isRejection(error)) return 'rejected';
        lastError = error;
        if (attempt < TOKEN_MAX_RETRIES) await sleep(TOKEN_RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    }
    report(lastError, { operation: 'refresh' });
    return null;
  }

  async function resolveToken(): Promise<string | null> {
    await ensureHydrated();

    const current = session;
    if (!current) return null;

    if (current.access_token && !isJwtExpired(current.access_token, skewSeconds)) {
      cachedToken = current.access_token;
      cachedAt = Date.now();
      return cachedToken;
    }

    if (!current.refresh_token) {
      // Nothing to refresh with. Hand back a token that is stale-by-skew but
      // not yet dead rather than nothing at all.
      return current.access_token && !isJwtExpired(current.access_token, 0)
        ? current.access_token
        : null;
    }

    const outcome = await refreshWithRetries(current.refresh_token);

    if (outcome === 'rejected') {
      await clear();
      emit('SIGNED_OUT');
      return null;
    }

    if (outcome) {
      await persist(outcome);
      emit('TOKEN_REFRESHED');
      return outcome.access_token;
    }

    // Network exhausted. The session stays; the last-known token is returned
    // while it is still inside its own `exp`.
    return current.access_token && !isJwtExpired(current.access_token, 0)
      ? current.access_token
      : null;
  }

  /**
   * ARROW-FUNCTION PROPERTY, not a prototype method, so
   * `createKortix({ getToken: auth.getToken })` works unbound. That single line
   * is the first thing every consumer writes.
   */
  const getToken = async (): Promise<string | null> => {
    try {
      if (
        cachedToken &&
        Date.now() - cachedAt < cacheTtlMs &&
        !isJwtExpired(cachedToken, skewSeconds)
      ) {
        return cachedToken;
      }

      // Five subsystems race for a token on page load. Without this they each
      // start their own refresh chain.
      if (inflight) return inflight;

      inflight = resolveToken();
      try {
        return await inflight;
      } finally {
        inflight = null;
      }
    } catch (error) {
      // getToken is the seam `authenticatedFetch` calls, and it already turns
      // null into a synthetic 401 (core/http/auth.ts:176-178) — the correct,
      // already-handled shape. A throw here would escape into every caller.
      report(error, { operation: 'getToken' });
      return null;
    }
  };

  async function readVerifier(): Promise<string | null> {
    const stored = await storage.getItem(verifierKey);
    return stored ?? null;
  }

  const auth: KortixAuth = {
    getToken,

    getSession: () => session,

    config: () => loadConfig(),

    async signInWithPassword(input) {
      const ctx = await gotrueContext();
      const next = await gotrueSignInWithPassword(ctx, input);
      await persist(next);
      emit('SIGNED_IN');
      return next;
    },

    async signInWithOtp(input) {
      const ctx = await gotrueContext();
      await gotrueSignInWithOtp(ctx, input);
    },

    async verifyOtp(input) {
      const ctx = await gotrueContext();
      const next = await gotrueVerifyOtp(ctx, input);
      await persist(next);
      emit('SIGNED_IN');
      return next;
    },

    async signOut(signOutOptions) {
      await ensureHydrated().catch((error: unknown) => report(error, { operation: 'signOut' }));
      const token = session?.access_token ?? null;
      if (token) {
        try {
          const ctx = await gotrueContext();
          await gotrueSignOut(ctx, token, signOutOptions?.scope ?? 'global');
        } catch (error) {
          // A sign-out that leaves a live token behind because the network
          // blipped is the worst outcome available: the user believes they are
          // signed out. Report it and clear locally regardless.
          report(error, { operation: 'signOut' });
        }
      }
      await clear();
      emit('SIGNED_OUT');
    },

    async getUser(userOptions) {
      await ensureHydrated();
      if (!userOptions?.force && session?.user) return session.user;

      const token = await getToken();
      if (!token) return null;

      const ctx = await gotrueContext();
      const user = await gotrueGetUser(ctx, token);
      if (session && user) {
        await persist({ ...session, user });
        emit('USER_UPDATED');
      }
      return user;
    },

    async refresh() {
      await ensureHydrated();
      const refreshToken = session?.refresh_token;
      if (!refreshToken) return null;

      const outcome = await refreshWithRetries(refreshToken);
      if (outcome === 'rejected') {
        await clear();
        emit('SIGNED_OUT');
        return null;
      }
      if (!outcome) return null;

      await persist(outcome);
      emit('TOKEN_REFRESHED');
      return outcome;
    },

    onChange(listener) {
      listeners.add(listener);
      // INITIAL is delivered once per listener with the hydrated session, so a
      // host never has to special-case "before the first event".
      void ensureHydrated()
        .catch(() => undefined)
        .then(() => {
          if (listeners.has(listener)) deliver(listener, { event: 'INITIAL', session });
        });
      return () => void listeners.delete(listener);
    },

    async authorizeUrl(provider, authorizeOptions) {
      const verifier = await createPkceVerifier();
      const challenge = await createPkceChallenge(verifier);
      await storage.setItem(verifierKey, verifier);
      const ctx = await gotrueContext();
      return gotrueAuthorizeUrl(ctx, {
        provider,
        ...(authorizeOptions?.redirectTo ? { redirectTo: authorizeOptions.redirectTo } : {}),
        ...(authorizeOptions?.scopes ? { scopes: authorizeOptions.scopes } : {}),
        codeChallenge: challenge,
      });
    },

    async exchangeCodeForSession(code) {
      const verifier = await readVerifier();
      if (!verifier) {
        throw new KortixAuthError(
          `No PKCE code verifier at "${verifierKey}" — call authorizeUrl() from the same client and storage that handles the callback.`,
          { code: 'pkce_verifier_missing' },
        );
      }
      const ctx = await gotrueContext();
      const next = await gotrueExchangeCodeForSession(ctx, { authCode: code, codeVerifier: verifier });
      await persist(next);
      await storage.removeItem(verifierKey);
      emit('SIGNED_IN');
      return next;
    },
  };

  if (options.syncAcrossTabs) subscribeToStorageEvents();

  /** Opt-in cross-tab sync. Guarded twice: the core may never touch a bare
   *  global, and a worker has no `window`. No `BroadcastChannel` in v1. */
  function subscribeToStorageEvents(): void {
    if (typeof window === 'undefined') return;
    if (typeof addEventListener !== 'function') return;
    addEventListener('storage', (event: unknown) => {
      const record = event as { key?: string | null; newValue?: string | null };
      if (record?.key !== storageKey) return;
      void loadConfig()
        .then((config) => {
          const next = parseStoredSession(record.newValue ?? null, config.url);
          session = next;
          cachedToken = next?.access_token ?? null;
          cachedAt = next ? Date.now() : 0;
          emit(next ? 'TOKEN_REFRESHED' : 'SIGNED_OUT');
        })
        .catch((error: unknown) => report(error, { operation: 'syncAcrossTabs' }));
    });
  }

  return auth;
}

/** 64 unreserved characters from `crypto.getRandomValues` — GoTrue's own
 *  verifier length and alphabet. */
async function createPkceVerifier(): Promise<string> {
  const cryptoApi = requirePkceCrypto();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = new Uint8Array(64);
  cryptoApi.getRandomValues(bytes);
  let verifier = '';
  for (const byte of bytes) verifier += alphabet[byte % alphabet.length];
  return verifier;
}

/** `base64url(SHA-256(verifier))`. S256 only — see `requirePkceCrypto`. */
async function createPkceChallenge(verifier: string): Promise<string> {
  const cryptoApi = requirePkceCrypto();
  // The verifier is ASCII by construction, so no TextEncoder is needed — one
  // less global this module has to assume exists.
  const bytes = new Uint8Array(verifier.length);
  for (let i = 0; i < verifier.length; i++) bytes[i] = verifier.charCodeAt(i);
  const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * GoTrue also accepts `code_challenge_method=plain`, and falling back to it
 * silently downgrades the flow. When `crypto.subtle` is missing (Hermes /
 * React Native without a polyfill) this fails loudly and names the missing API.
 */
function requirePkceCrypto(): Crypto {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== 'function') {
    throw new KortixAuthError(
      'PKCE needs crypto.subtle and crypto.getRandomValues, which this runtime does not provide. Install a WebCrypto polyfill (React Native/Hermes) or sign in with a password or an email OTP instead.',
      { code: 'pkce_unsupported' },
    );
  }
  return cryptoApi;
}
