/**
 * True only inside the packaged desktop bundle.
 *
 * `apps/web/desktop/build.mjs` statically exports the (app) route group for the
 * Electron shell to serve over `app://`. That bundle has NO server: every
 * `src/app/**\/route.ts` handler is absent, so any same-origin `fetch('/api/…')`
 * from client code 404s there. Client modules must branch on this constant
 * rather than on `process.env.KORTIX_DESKTOP_BUILD`, which Next only inlines
 * into the client bundle for `NEXT_PUBLIC_`-prefixed names.
 *
 * The flag is injected by next.config.ts and is `undefined` for the web build,
 * so every branch guarded by it is dead code Turbopack drops on kortix.com.
 */
export const IS_DESKTOP_BUILD = process.env.NEXT_PUBLIC_KORTIX_DESKTOP_BUILD === '1';
