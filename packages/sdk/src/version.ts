/**
 * The published package version, as seen from INSIDE the package (e.g. for
 * `clientInfo.version` on ACP `initialize`). This is a dev-time placeholder —
 * `scripts/stage-npm-publish.mjs` rewrites the compiled `dist/version.js` (and
 * `dist/version.d.ts`) at release time, replacing `'0.0.0-dev'` with the exact
 * release version (`$VERSION` / the root `VERSION` file), the same version it
 * stamps onto `package.json`.
 *
 * Not part of the public `exports` map — internal, imported only via relative
 * path (e.g. `../version` from `react/use-acp-session.ts`).
 */
export const SDK_VERSION = '0.0.0-dev';
