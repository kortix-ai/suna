/**
 * Desktop runtime detection + native window helpers.
 *
 * The Tauri shell sets a custom user-agent (`doscoDesktop/...`) and exposes
 * the Tauri JS bridge as `window.__TAURI__` (because `app.withGlobalTauri` is
 * true in tauri.conf.json). We use the user-agent for detection because it's
 * available synchronously before hydration; we use the global bridge for
 * window controls so the web app doesn't take a hard dependency on
 * `@tauri-apps/api`.
 */

export const DESKTOP_UA_TOKEN = 'doscoDesktop';

/**
 * Base path for desktop downloads. `/download` is the public page; the
 * `/download/<platform>` children 302 to the latest installer for that OS —
 * same pattern as the CLI's `/install`. Override with
 * NEXT_PUBLIC_DESKTOP_DOWNLOAD_URL if needed.
 */
export const DESKTOP_DOWNLOAD_URL =
  process.env.NEXT_PUBLIC_DESKTOP_DOWNLOAD_URL || '/download';

/**
 * Build a per-platform download URL, e.g. desktopDownloadUrl('macos') →
 * '/download/macos'. Without a platform this returns '/download', which is the
 * public page — it lets the visitor choose, and highlights their OS.
 */
export function desktopDownloadUrl(platform?: 'macos' | 'windows' | 'linux'): string {
  if (!platform) return DESKTOP_DOWNLOAD_URL;
  return `${DESKTOP_DOWNLOAD_URL.replace(/\/$/, '')}/${platform}`;
}

/**
 * Navigate to `href` via a transient anchor element. We deliberately avoid
 * `window.open` because the desktop shell's window-open shim routes that
 * through the `open_external` IPC command, which errors on older builds
 * ("Plugin not found"). A plain same-tab navigation instead lets the Tauri
 * navigation gate open non-product URLs in the system browser, and on the web a
 * file download (302 → installer) doesn't navigate the page away.
 */
function clickAnchor(href: string, newTab = false) {
  if (typeof document === 'undefined') return;
  const a = document.createElement('a');
  a.href = href;
  if (newTab) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Trigger a desktop-installer download. Safe on web and in the desktop app. */
export function startDownload(url: string = DESKTOP_DOWNLOAD_URL) {
  clickAnchor(url, false);
}

export type DesktopPlatform = 'macos' | 'windows' | 'linux';

export function isDesktop(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.userAgent.includes(DESKTOP_UA_TOKEN);
}

/**
 * For routes that don't exist inside the desktop app (docs, marketing, …):
 * on desktop open them in the user's real browser and return true; on web
 * return false so the caller navigates normally. Client-side `router.push`
 * to these routes otherwise just bounces to /projects via middleware, so the
 * link appears to "do nothing". `window.open` is routed to the system browser
 * by the Tauri shell's window-open shim.
 */
export function openExternalRoute(path: string): boolean {
  if (typeof window === 'undefined' || !isDesktop()) return false;
  const abs = /^https?:\/\//.test(path)
    ? path
    : `${window.location.origin}${path.startsWith('/') ? path : `/${path}`}`;
  // Plain same-tab navigation: the Tauri nav gate cancels it and opens the URL
  // in the system browser (no `open_external` IPC, which 404s on old builds).
  clickAnchor(abs, false);
  return true;
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

export type DesktopShellPlatform = 'macos' | 'other';

/**
 * Chrome-layout bucket for the desktop shell: macOS puts the window controls
 * top-left (traffic lights), everything else top-right. `null` on the web.
 * Shared by the title-bar surfaces (project shell, session header, tab bar)
 * so they indent/align consistently.
 */
export function desktopShellPlatform(): DesktopShellPlatform | null {
  const platform = desktopPlatform();
  if (!platform) return null;
  return platform === 'macos' ? 'macos' : 'other';
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
 * email magic links should redirect here (instead of `https://dosco.live/...`)
 * so the OS hands the callback back to the desktop app rather than opening
 * it in the user's browser.
 */
export const DESKTOP_URL_SCHEME = 'kortix';

/**
 * Returns the right OAuth redirect target for the current runtime:
 * - Desktop: HTTPS `/auth/callback?desktop=true&...` so the user's browser
 *   lands on a real page after Supabase's 302. That page renders a "you're
 *   signed in" UI and JS-bounces to `kortix://auth/callback?...`. Going
 *   straight to `kortix://` leaves the browser tab spinning forever — the
 *   OS opens the app but the tab itself has nowhere to navigate.
 * - Web: the standard origin-based callback URL.
 *
 * The desktop bounce uses the desktop's loaded origin (typically
 * `http://localhost:3000` in dev, `https://dosco.live` in prod) so the
 * Supabase redirect URL allowlist only needs the standard callbacks.
 */
export function authRedirectUrl(path: string = '/auth/callback'): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (typeof window === 'undefined') return cleanPath;
  const origin = window.location.origin;
  if (isDesktop()) {
    const sep = cleanPath.includes('?') ? '&' : '?';
    return `${origin}${cleanPath}${sep}desktop=true`;
  }
  return `${origin}${cleanPath}`;
}

/* ─── Zoom (browser-style Cmd+/Cmd-/Cmd0) ─────────────────────────────── */

const ZOOM_KEY = 'kortix-desktop-zoom';
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 1.1;

/**
 * The desktop shell renders the web app one notch smaller than the browser
 * does. A desktop window is a fixed frame the user sizes once, not a tab among
 * tabs, so the web's default type and control sizes read oversized in it —
 * every native app it sits beside is denser.
 *
 * This is REAL browser zoom (`webContents.setZoomFactor`), not CSS `zoom`. CSS
 * `zoom` does not scale viewport units, so `h-svh` / `min-h-svh` / `h-dvh`
 * would each resolve to 90% of the window and leave a dead strip at the bottom
 * — and the capabilities layout pins its tab bar with `h-svh` specifically.
 * Browser zoom changes the CSS-pixel scale itself, so viewport units, media
 * queries and DPI all stay correct.
 *
 * MUST equal `--kx-desktop-zoom` in globals.css, which divides the title-bar
 * offsets back out: the macOS traffic lights are drawn by the OS in WINDOW
 * pixels and do not zoom, so a CSS offset of 72px would land at 64.8px and
 * break the alignment. desktop-titlebar.test.ts asserts the two agree.
 */
export const DESKTOP_BASE_ZOOM = 0.94;

const clampZoom = (n: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));

/**
 * A stored zoom is an ABSOLUTE factor, so it only means anything relative to
 * the base it was chosen against. Stamp the base alongside it: a user's own
 * Cmd+/Cmd- still survives restarts, but once the shell's default moves, values
 * picked against the old one are stale and the new default wins.
 *
 * Without this, changing DESKTOP_BASE_ZOOM is a no-op for anyone who has ever
 * touched the zoom keys — the app keeps rendering at their old factor and the
 * new default is invisible.
 */
function readStoredZoom(): number | null {
  const raw = window.localStorage.getItem(ZOOM_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { scale?: number; base?: number };
    if (parsed?.base !== DESKTOP_BASE_ZOOM) return null; // chosen against an older default
    return Number.isFinite(parsed.scale) ? clampZoom(parsed.scale!) : null;
  } catch {
    // Pre-versioning value: a bare number, chosen against an older default.
    return null;
  }
}

export function getDesktopZoom(): number {
  if (typeof window === 'undefined') return DESKTOP_BASE_ZOOM;
  try {
    return readStoredZoom() ?? DESKTOP_BASE_ZOOM;
  } catch {
    return DESKTOP_BASE_ZOOM;
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
    // Stamped with the base it was chosen against — see readStoredZoom.
    window.localStorage.setItem(
      ZOOM_KEY,
      JSON.stringify({ scale: next, base: DESKTOP_BASE_ZOOM }),
    );
  } catch {
    /* private mode */
  }
  // Publish the LIVE factor to CSS. The title-bar offsets divide by it to stay
  // pinned to the OS window controls, which never zoom — so this has to track
  // the user's Cmd+/Cmd- too, not just the shell default. globals.css seeds it
  // with DESKTOP_BASE_ZOOM so the very first paint is already correct.
  try {
    document.documentElement.style.setProperty('--kx-desktop-zoom', String(next));
  } catch {
    /* no document (SSR) */
  }
  await invokeSetZoom(next);
  return next;
}

export const zoomIn = () => setDesktopZoom(getDesktopZoom() * ZOOM_STEP);
export const zoomOut = () => setDesktopZoom(getDesktopZoom() / ZOOM_STEP);
/** Back to the shell's own scale, not the browser's 100%. */
export const zoomReset = () => setDesktopZoom(DESKTOP_BASE_ZOOM);

/* ─── Frontend URL override (self-hosting) ───────────────────────────────
   The switcher lives in the hidden native menu (dosco → Frontend URL). Its
   "Custom URL…" item can't take text input natively, so it fires a
   `kortix-open-frontend-url` DOM event that the desktop-only prompt listens
   for; the prompt then persists the value via these commands. The override is
   stored locally in the Tauri app config dir and reloads the window. */

function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> | null {
  if (typeof window === 'undefined') return null;
  const t = (window as unknown as {
    __TAURI__?: { core?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } };
  }).__TAURI__;
  if (!t?.core?.invoke) return null;
  return t.core.invoke(cmd, args) as Promise<T>;
}

/** Effective frontend URL the desktop shell is currently pointed at. */
export async function getFrontendUrl(): Promise<string | null> {
  try {
    return (await tauriInvoke<string>('get_frontend_url')) ?? null;
  } catch {
    return null;
  }
}

/** Persist a custom frontend URL and reload the desktop window onto it. */
export async function setFrontendUrl(url: string): Promise<void> {
  await tauriInvoke('set_frontend_url', { url });
}

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
