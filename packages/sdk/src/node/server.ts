/**
 * `@kortix/sdk/server` — Node/Bun-only request-scoped config isolation for
 * "Kortix as a Backend": a third-party server process that wraps Kortix on
 * behalf of multiple end users/tenants concurrently.
 *
 * NEVER import this subpath from a browser bundle. It statically imports
 * `config-node.ts`, which statically imports `node:async_hooks` — most
 * browser bundlers choke if that appears anywhere in their graph. The root
 * `@kortix/sdk` entry point and `@kortix/sdk/react` never import this file,
 * so a web host's bundle is unaffected either way; this subpath exists
 * specifically for the non-browser "backend" case.
 *
 * Why this exists: `configureKortix()`/`createKortix()` (the root `@kortix/sdk`
 * seam) store the platform config — crucially, the bearer token getter — in a
 * single process-wide module-global (see `platform/config.ts`). That's fine
 * for a host with exactly one config for its whole lifetime (a browser tab, a
 * CLI, a single-tenant server). It is UNSAFE for a server process handling
 * concurrent requests on behalf of different users: two in-flight requests
 * racing through `configureKortix()` with different tokens clobber each
 * other — whichever call landed last wins for every other in-flight request
 * (see the warning on `ServerTokenOptions` in
 * `platform/projects-client/shared.ts`).
 *
 * `runWithKortix`/`createScopedKortix` fix that using Node's
 * `AsyncLocalStorage`: the config passed to one call is visible ONLY inside
 * that call's async continuation (every `await` inside it), correctly
 * isolated from any other concurrent call in the same process.
 */
export { runWithKortix, getScopedConfig } from '../platform/config-node';
export { createScopedKortix, forwardKortixRequest } from './scoped-client';
/**
 * "Sign in with Kortix" for a standalone app — OAuth 2.1 sign-in, session
 * cookie, refresh, sign-out, `/me`, and a same-origin `/proxy`. See ./auth.ts.
 */
export {
  createKortixAuth,
  KortixAuthError,
  KORTIX_SESSION_SENTINEL,
  safeReturnTo,
  type KortixAuth,
  type KortixFetch,
  type KortixAuthOptions,
  type KortixViewer,
  type RequireViewerResult,
} from './auth';

/**
 * Types a server-side consumer's declaration emit may need to name `Kortix`
 * (the `auth` member and its session store) without reaching into src/.
 */
export type { HeadlessAuthApi, AuthSession, AuthUser, AuthSessionResult, AuthRequestOptions } from '../core/rest/platform-client/auth';
export type { KortixSession, KortixSessionOptions, KortixSessionStorage } from '../core/auth/session';
export { createKortixAppGuard } from './app-guard';
export type {
  KortixAppGuard,
  KortixAppGuardOptions,
  KortixAppGuardResult,
  KortixGuardedViewer,
} from './app-guard';

/**
 * Kortix Apps — the viewer the Apps gate signs into every request. See
 * ./app-viewer.ts: an App hosted by Kortix authenticates its visitor with no
 * login of its own.
 */
export {
  readAppViewer,
  createAppViewerKortix,
  AppViewerUnavailableError,
  APP_VIEWER_HEADER,
  APP_VIEWER_TOKEN_HEADER,
  APP_VIEWER_SECRET_ENV,
  type KortixAppViewer,
  type ReadAppViewerOptions,
} from './app-viewer';
