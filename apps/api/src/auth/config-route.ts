/**
 * GET /v1/auth/config — PUBLIC sign-in discovery.
 *
 * `@kortix/sdk` can do everything with a token and nothing to get one: a
 * consumer pointed at `https://api.kortix.com/v1` has no supported way to learn
 * the browser-reachable GoTrue origin or the publishable anon key it needs to
 * sign a user in. This route is that answer, and it is the ONLY unauthenticated
 * Kortix call the SDK auth module makes.
 *
 * Three properties define the contract:
 *
 *  1. UNAUTHENTICATED. No `Authorization` header is read. The body is
 *     byte-identical with and without one — pinned by test in
 *     `config-route.test.ts`, because `Cache-Control: public` is only honest
 *     while nothing varies per caller, per account, or per tenant. There is
 *     deliberately no `Vary: Authorization`: adding one would be an admission
 *     that the payload varies, which it must not.
 *
 *  2. IT SERVES ONLY PUBLIC VALUES. `anon_key` is the *publishable* key —
 *     apps/web already ships the identical value to every browser that loads
 *     the app (apps/web/src/lib/env-config.ts:29) and GoTrue itself requires it
 *     as the `apikey` header. `SUPABASE_SERVICE_ROLE_KEY` must never appear
 *     here; that is an explicit negative assertion in the test file, not an
 *     assumption.
 *
 *  3. IT FAILS LOUD RATHER THAN HAND OUT A UNREACHABLE URL. On a self-host box
 *     `kortix-api` sees `SUPABASE_URL=http://supabase-kong:8000`
 *     (apps/cli/src/self-host/assets/kortix-compose.yml:60) — a hostname no
 *     browser can resolve. Serving that produces an opaque network error on
 *     every sign-in attempt, days later, in someone else's app. So a bare
 *     container name with no `SUPABASE_PUBLIC_URL` is a 503 at the source.
 *
 * MOUNTING — read this before moving a line in apps/api/src/index.ts.
 * `authRouter` (./index.ts) gates everything on it with
 * `authRouter.use('/*', supabaseAuth)`. This route must NOT be gated, so it
 * lives on its own router with no middleware, registered on `/v1/auth` BEFORE
 * `authRouter`. Hono matches in registration order, so the public handler
 * answers before `authRouter`'s `use('/*')` is ever composed. That is correct
 * and fragile: one reorder silently either gates `/config` or un-gates
 * `/logout`. The guard is the test that asserts both halves against the real
 * `app`, not this comment.
 *
 * Narrowing `authRouter.use('/*')` to `use('/logout')` was rejected: it would
 * make every future route on that router unauthenticated by default.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { config } from '../config';
import { errors, json, makeOpenApiApp } from '../openapi';
import { areSignupsEnabled } from '../shared/access-control-cache';
import { computeEtag, etagMatches } from '../shared/http-cache';

/** Email sign-in methods a deployment can enable. */
export const AUTH_METHOD_VALUES = ['magic', 'password'] as const;
export type AuthMethod = (typeof AUTH_METHOD_VALUES)[number];

export const AuthConfigSchema = z
  .object({
    /**
     * A literal today, a union tomorrow. Keeping it in the payload lets an old
     * SDK REFUSE an unknown backend instead of guessing GoTrue's wire format.
     */
    provider: z.literal('supabase'),
    /** Browser-reachable GoTrue ORIGIN. No `/auth/v1` suffix, no trailing slash. */
    url: z.string().url(),
    /** The publishable key. Public by definition — see the file header. */
    anon_key: z.string().min(1),
    methods: z.array(z.enum(AUTH_METHOD_VALUES)),
    providers: z.array(z.string()),
    signups_enabled: z.boolean(),
  })
  .openapi('AuthConfig');

export type AuthConfigBody = z.infer<typeof AuthConfigSchema>;

/** Everything the payload is derived from, named explicitly so it is testable. */
export interface AuthConfigEnv {
  supabaseUrl: string;
  supabasePublicUrl: string;
  anonKey: string;
  /** Raw `AUTH_METHODS` comma list. */
  authMethods: string;
  /** Raw `AUTH_PROVIDERS` comma list. */
  authProviders: string;
  signupsEnabled: boolean;
}

/**
 * Port of `parseAuthMethods` (apps/web/src/lib/auth/unified-auth-flow.ts:34-40).
 * Same rule, deliberately not re-derived: unknown entries are dropped and an
 * empty result falls back to both methods, so a typo never renders a login form
 * with no way to sign in.
 */
export function parseAuthMethods(raw: string | null | undefined): AuthMethod[] {
  const parsed = (raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is AuthMethod => s === 'magic' || s === 'password');
  return parsed.length ? [...new Set(parsed)] : ['magic', 'password'];
}

/**
 * Same parse as apps/web/src/app/(auth)/auth/page.tsx:169-175, plus dedupe.
 * Absent → `[]`: a deployment with no social provider configured must render no
 * social button, so there is no fallback here.
 */
export function parseAuthProviders(raw: string | null | undefined): string[] {
  return [
    ...new Set(
      (raw || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/**
 * Can a browser on the public internet resolve this host?
 *
 * `supabase-kong` cannot; `supa.kortix.com`, `localhost` and `127.0.0.1` can.
 * The dot test is crude on purpose — it is the exact shape of the self-host
 * failure (a bare Docker service name) and nothing else needs to be caught.
 */
export function isBrowserReachableUrl(raw: string): boolean {
  let host: string;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    return true;
  }
  return host.includes('.');
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Build the payload, or `null` when this deployment cannot answer.
 *
 * Pure: every input is an argument, so the whole field-source and 503 matrix is
 * unit-testable without mutating process.env or rebuilding the config module.
 */
export function resolveAuthConfig(env: AuthConfigEnv): AuthConfigBody | null {
  const anonKey = env.anonKey.trim();
  if (!anonKey) return null;

  const publicUrl = stripTrailingSlash(env.supabasePublicUrl.trim());
  const internalUrl = stripTrailingSlash(env.supabaseUrl.trim());
  // PUBLIC wins: SUPABASE_URL is an internal Docker hostname on self-host.
  const url = publicUrl || internalUrl;
  if (!url) return null;
  // The reachability rule applies to whichever value we are about to serve.
  if (!isBrowserReachableUrl(url)) return null;

  return {
    provider: 'supabase',
    url,
    anon_key: anonKey,
    methods: parseAuthMethods(env.authMethods),
    providers: parseAuthProviders(env.authProviders),
    signups_enabled: env.signupsEnabled,
  };
}

/**
 * The live deployment's values. Read per request so a hot-reload is visible.
 *
 * `config.SUPABASE_ANON_KEY` is already the resolved head of the three-name
 * fallback chain (SUPABASE_ANON_KEY → KORTIX_PUBLIC_SUPABASE_ANON_KEY →
 * NEXT_PUBLIC_SUPABASE_ANON_KEY, see config.ts `resolveAnonKey`). Do not
 * re-derive the chain here: one resolution site, one order, one thing to test.
 */
export function readAuthConfigEnv(): AuthConfigEnv {
  return {
    supabaseUrl: config.SUPABASE_URL ?? '',
    supabasePublicUrl: config.SUPABASE_PUBLIC_URL ?? '',
    anonKey: config.SUPABASE_ANON_KEY ?? '',
    authMethods: config.AUTH_METHODS ?? '',
    authProviders: config.AUTH_PROVIDERS ?? '',
    signupsEnabled: areSignupsEnabled(),
  };
}

// Names all three accepted anon-key variables: an operator who already set the
// frontend's name and still got a 503 must be able to tell from this message
// that the API read it too, so the real fault is the URL half.
const UNAVAILABLE_MESSAGE =
  'Sign-in discovery is not configured on this deployment. Set SUPABASE_ANON_KEY ' +
  '(or KORTIX_PUBLIC_SUPABASE_ANON_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY), and set ' +
  'SUPABASE_PUBLIC_URL when SUPABASE_URL is an internal hostname.';

/**
 * Factory so tests can drive the real handler against a hermetic env instead of
 * rebuilding the config singleton. Production uses the default reader.
 */
export function createAuthConfigRouter(readEnv: () => AuthConfigEnv = readAuthConfigEnv) {
  const router = makeOpenApiApp();

  router.openapi(
    createRoute({
      method: 'get',
      path: '/config',
      tags: ['auth'],
      summary: 'Public sign-in discovery (GoTrue origin, anon key, enabled methods)',
      description:
        'Unauthenticated. Returns only values that are already public. Used by ' +
        '@kortix/sdk to sign a user in against this deployment.',
      responses: {
        200: json(AuthConfigSchema, 'Sign-in discovery'),
        304: { description: 'Not modified (If-None-Match matched)' },
        ...errors(503),
      },
    }),
    // Cacheable and `public` BECAUSE the body never varies per caller. max-age
    // is 60s rather than the maintenance route's 5s: this payload changes only
    // on deploy, whereas maintenance is an emergency kill switch. No rate limit
    // — unlike /access/check-email this is not an oracle about anybody's
    // account, it is a static constant, and ETag + max-age is the load control.
    (c: any) => {
      const payload = resolveAuthConfig(readEnv());
      if (!payload) {
        return c.json(
          {
            error: true,
            code: 'auth_config_unavailable',
            message: UNAVAILABLE_MESSAGE,
            status: 503,
          },
          503,
        );
      }
      const etag = computeEtag(payload);
      c.header('Cache-Control', 'public, max-age=60, must-revalidate');
      c.header('ETag', etag);
      if (etagMatches(c.req.header('If-None-Match'), etag)) return c.body(null, 304);
      return c.json(payload);
    },
  );

  return router;
}

/** Mounted at `/v1/auth` BEFORE `authRouter` — see the file header. */
export const authConfigRouter = createAuthConfigRouter();
