/**
 * Auth cookies for the Kortix in Chrome side panel.
 *
 * The panel frames this app inside an extension page. Chrome hides
 * SameSite=Lax cookies from such a frame, so the panel keeps its own session in
 * a partitioned cookie (`SameSite=None; Secure; Partitioned`). Chrome keys that
 * cookie by the embedding extension, so it never mixes with the session of the
 * user's own tab.
 *
 * The browser knows it is in the panel from `location.ancestorOrigins`. The
 * server cannot see that, so the browser also writes the `kortix_panel` marker
 * cookie, partitioned the same way. A request that carries the marker is a
 * panel request, and every auth cookie the server sets or deletes uses the same
 * options.
 */
import { KORTIX_EXTENSION_ID } from '@kortix/ui/internal/chrome/extension';

export const PANEL_MARKER_COOKIE = 'kortix_panel';
export const PANEL_AUTH_PATH = '/auth/panel';
const PANEL_DEFAULT_NEXT = '/projects';
const MARKER_MAX_AGE = 60 * 60 * 24 * 400;

/** `chrome-extension://<id>`: the only origin the panel talks to. */
export const EXTENSION_ORIGIN = `chrome-extension://${KORTIX_EXTENSION_ID}`;

export interface AuthCookieOptions {
  path: '/';
  sameSite: 'lax' | 'none';
  secure: boolean;
  partitioned?: true;
}

/** Cookie attributes for the Supabase auth cookie, and for any cookie that must travel with it. */
export function authCookieOptions(panel: boolean, secure: boolean): AuthCookieOptions {
  return panel
    ? { path: '/', sameSite: 'none', secure: true, partitioned: true }
    : { path: '/', sameSite: 'lax', secure };
}

/**
 * True when this document is the Kortix in Chrome side panel: framed, and the
 * framing page is the extension. `ancestorOrigins` is exact (Chrome sets it,
 * Firefox does not). The referrer is the fallback, and it is a hint, not a
 * credential: the extension checks `event.origin` on its side.
 */
export function isExtensionPanelFrame(
  ancestorOrigins: ArrayLike<string> | undefined,
  referrer: string,
  framed: boolean,
): boolean {
  if (!framed) return false;
  if (ancestorOrigins && ancestorOrigins.length > 0) return ancestorOrigins[0] === EXTENSION_ORIGIN;
  return referrer === EXTENSION_ORIGIN || referrer.startsWith(`${EXTENSION_ORIGIN}/`);
}

/** Browser only: is the current document the side panel? */
export function isInExtensionPanel(): boolean {
  if (typeof window === 'undefined') return false;
  return isExtensionPanelFrame(window.location.ancestorOrigins, document.referrer, window.top !== window.self);
}

/** True when a `Cookie` header or a cookie store carries the panel marker. */
export function hasPanelMarker(cookies: { get(name: string): { value: string } | undefined }): boolean {
  return cookies.get(PANEL_MARKER_COOKIE)?.value === '1';
}

/** Browser only: write the partitioned marker the server reads. */
export function writePanelMarker(): void {
  document.cookie = `${PANEL_MARKER_COOKIE}=1; Path=/; Max-Age=${MARKER_MAX_AGE}; Secure; SameSite=None; Partitioned`;
}

/**
 * The page to open after the panel signs in: a same-origin relative path.
 * Anything else, and `/auth/*` (a redirect loop), becomes `/projects`.
 */
export function safePanelNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return PANEL_DEFAULT_NEXT;
  if (raw === '/auth' || raw.startsWith('/auth/') || raw.startsWith('/auth?')) return PANEL_DEFAULT_NEXT;
  return raw;
}

/** `/auth/panel?next=…` for a path the panel wants to reach. */
export function panelAuthUrl(next: string | null | undefined): string {
  return `${PANEL_AUTH_PATH}?next=${encodeURIComponent(safePanelNext(next))}`;
}
