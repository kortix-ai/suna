/**
 * Desktop runtime detection + native window helpers.
 *
 * The Tauri shell sets a custom user-agent (`KortixDesktop/...`) and exposes
 * the Tauri JS bridge as `window.__TAURI__` (because `app.withGlobalTauri` is
 * true in tauri.conf.json). We use the user-agent for detection because it's
 * available synchronously before hydration; we use the global bridge for
 * window controls so the web app doesn't take a hard dependency on
 * `@tauri-apps/api`.
 */

const DESKTOP_UA_TOKEN = 'KortixDesktop';

export type DesktopPlatform = 'macos' | 'windows' | 'linux';

export function isDesktop(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.userAgent.includes(DESKTOP_UA_TOKEN);
}

export function desktopPlatform(): DesktopPlatform | null {
  if (typeof navigator === 'undefined') return null;
  if (!navigator.userAgent.includes(DESKTOP_UA_TOKEN)) return null;
  // navigator.platform is host-OS-derived and unaffected by our custom UA.
  // userAgent here is replaced (not appended) by Tauri, so OS substrings are gone.
  const p = navigator.platform || '';
  if (p.startsWith('Mac')) return 'macos';
  if (p.startsWith('Win')) return 'windows';
  return 'linux';
}

type TauriWindow = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized: (cb: () => void) => Promise<() => void>;
};

type TauriGlobal = {
  window: { getCurrentWindow: () => TauriWindow };
};

function tauri(): TauriGlobal | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

/**
 * Custom URL scheme registered by the desktop shell. OAuth providers and
 * email magic links should redirect here (instead of `https://kortix.com/...`)
 * so the OS hands the callback back to the desktop app rather than opening
 * it in the user's browser.
 */
export const DESKTOP_URL_SCHEME = 'kortix';

/**
 * Returns the right OAuth redirect target for the current runtime:
 * - Desktop: `kortix://auth/callback?...` so Supabase bounces the auth code
 *   back into the app via the deep-link handler.
 * - Web: the standard origin-based callback URL.
 *
 * Pass this to `supabase.auth.signInWithOAuth({ options: { redirectTo: ... } })`
 * and add the desktop URL to Supabase's allowed redirect list.
 */
export function authRedirectUrl(path: string = '/auth/callback'): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (isDesktop()) {
    return `${DESKTOP_URL_SCHEME}:/${cleanPath}`;
  }
  if (typeof window !== 'undefined') {
    return `${window.location.origin}${cleanPath}`;
  }
  return cleanPath;
}

/* ─── Zoom (browser-style Cmd+/Cmd-/Cmd0) ─────────────────────────────── */

const ZOOM_KEY = 'kortix-desktop-zoom';
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 1.1;

const clampZoom = (n: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));

export function getDesktopZoom(): number {
  if (typeof window === 'undefined') return 1;
  try {
    const v = parseFloat(window.localStorage.getItem(ZOOM_KEY) || '');
    return Number.isFinite(v) ? clampZoom(v) : 1;
  } catch {
    return 1;
  }
}

async function invokeSetZoom(scale: number): Promise<void> {
  const t = (window as unknown as { __TAURI__?: { core?: { invoke?: (cmd: string, args: unknown) => Promise<unknown> } } }).__TAURI__;
  if (!t?.core?.invoke) return;
  try {
    await t.core.invoke('set_zoom', { scale });
  } catch {
    /* webview not ready yet — applied on next interaction */
  }
}

export async function setDesktopZoom(scale: number): Promise<number> {
  const next = clampZoom(scale);
  try {
    window.localStorage.setItem(ZOOM_KEY, String(next));
  } catch {
    /* private mode */
  }
  await invokeSetZoom(next);
  return next;
}

export const zoomIn = () => setDesktopZoom(getDesktopZoom() * ZOOM_STEP);
export const zoomOut = () => setDesktopZoom(getDesktopZoom() / ZOOM_STEP);
export const zoomReset = () => setDesktopZoom(1);

export const desktopWindow = {
  minimize: () => tauri()?.window.getCurrentWindow().minimize(),
  toggleMaximize: () => tauri()?.window.getCurrentWindow().toggleMaximize(),
  close: () => tauri()?.window.getCurrentWindow().close(),
  isMaximized: async () => {
    const t = tauri();
    if (!t) return false;
    return t.window.getCurrentWindow().isMaximized();
  },
  onResized: async (cb: () => void) => {
    const t = tauri();
    if (!t) return () => {};
    return t.window.getCurrentWindow().onResized(cb);
  },
};

/**
 * Inline script run in <head> before hydration. Sets `data-desktop` and
 * `data-desktop-platform` on <html> so CSS can react before first paint —
 * eliminates the layout shift you'd get from a useEffect-driven flag.
 */
export const DESKTOP_INIT_SCRIPT = `
(function() {
  try {
    var ua = navigator.userAgent || '';
    if (ua.indexOf('${DESKTOP_UA_TOKEN}') === -1) return;
    var html = document.documentElement;
    html.setAttribute('data-desktop', 'true');
    var p = navigator.platform || '';
    var platform = 'linux';
    if (p.indexOf('Mac') === 0) platform = 'macos';
    else if (p.indexOf('Win') === 0) platform = 'windows';
    html.setAttribute('data-desktop-platform', platform);
  } catch (e) {}
})();
`.trim();
