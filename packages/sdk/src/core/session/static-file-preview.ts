/**
 * Framing a file from the sandbox's static file server.
 *
 * A host that wants to SHOW an HTML file has exactly one correct move: load it
 * from the server that ships inside the sandbox (port 3211, `/open?path=…`) and
 * frame that URL. The tempting shortcut — hand the file's text to an iframe as
 * `srcDoc` — cannot work, and not for a reason a flag can fix: `srcDoc` gives
 * the document no URL at all, so `./style.css`, `img/logo.png` and `app.js`
 * have no base to resolve against. A page written as a page arrives unstyled.
 *
 * Two rules live here rather than in the hook, because both are decisions and
 * neither needs a network to be reasoned about.
 */

import {
  buildStaticFileHealthPreviewUrl,
  buildStaticFilePreviewUrl,
  hasPreviewTarget,
  type SubdomainUrlOptions,
} from './url';

/** Where to frame from, and where to ask whether framing will work yet. */
export interface StaticFilePreviewTargets {
  /** The proxied `/open?path=…` URL for the file itself. */
  previewUrl: string;
  /** The same service's `/health`, used to wait out a still-booting sandbox. */
  healthUrl: string;
}

/**
 * Resolve both URLs for one file, or `null` when there is nothing to address.
 *
 * The `null` is the whole point. `buildStaticFilePreviewUrl` answers with the
 * INTERNAL form — `http://localhost:3211/open?path=…` — when no sandbox is
 * bound, which is honest for a link that will be re-resolved on click and
 * actively wrong for anything that loads or probes it now: that port is on the
 * viewer's own machine. Framing it shows whatever the user happens to be
 * running; probing it can answer `200` and mark a preview "ready" that can
 * never load. A sandbox binds asynchronously, so every caller passes through
 * this state on the way to a working preview — it is the common case, not an
 * edge one.
 */
export function staticFilePreviewTargets(
  path: string | undefined,
  options: SubdomainUrlOptions,
): StaticFilePreviewTargets | null {
  if (!path) return null;
  if (!hasPreviewTarget(options)) return null;

  const previewUrl = buildStaticFilePreviewUrl(path, options);
  if (!previewUrl) return null;

  return { previewUrl, healthUrl: buildStaticFileHealthPreviewUrl(options) };
}

/** Gap between liveness probes, ms. */
export const STATIC_FILE_HEALTH_RETRY_MS = 1_500;

/**
 * How many probes before the wait becomes a reported failure.
 *
 * 20 × 1.5s ≈ 30s. The bound is not a guess about how long a sandbox takes to
 * boot — it is the line past which silence stops being informative. Without it
 * a surface spins "Starting preview server…" for the life of the tab; with it
 * the user gets a sentence and a Retry.
 */
export const STATIC_FILE_HEALTH_MAX_ATTEMPTS = 20;

/** Whether a caller that has made `attempts` probes should make another. */
export function shouldRetryStaticFileHealth(attempts: number): boolean {
  return attempts < STATIC_FILE_HEALTH_MAX_ATTEMPTS;
}

/**
 * Does an authenticated preview URL address the file we are asking for?
 *
 * `useAuthenticatedPreviewUrl` resolves in an effect, so on the render where a
 * viewer switches to a different file it still holds the PREVIOUS file's URL.
 * Framing that shows the page the user just navigated away from. A prefix test
 * is exact enough for both forms authentication produces: the path-based form
 * is the preview URL unchanged, and the subdomain form is the preview URL plus
 * a one-shot `token` query.
 */
export function authenticatedUrlAddresses(
  authenticatedUrl: string | null | undefined,
  previewUrl: string | undefined,
): boolean {
  if (!authenticatedUrl || !previewUrl) return false;
  return authenticatedUrl.startsWith(previewUrl);
}
