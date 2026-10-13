/**
 * The Kortix Chrome extension, seen from the web app.
 *
 * A page talks to the extension through `chrome.runtime.sendMessage(id, …)`
 * (`externally_connectable`). Chrome exposes `chrome.runtime` to a page only
 * when the extension is installed and lists the page's origin. Safari, Firefox
 * and the desktop shell never expose it, so `pingExtension` answers `null`.
 */

export const KORTIX_EXTENSION_ID =
  process.env.NEXT_PUBLIC_KORTIX_EXTENSION_ID || 'gefbbnjgoiljpbnalgafbhbfdhikgjek';

export const KORTIX_EXTENSION_STORE_URL = `https://chromewebstore.google.com/detail/${KORTIX_EXTENSION_ID}`;

/**
 * The Web Store listing is public. While `false`, no surface offers "Add to
 * Chrome": each one shows "Connect" and a "How to install" link to the docs.
 * Flip it with the listing, nothing else changes.
 */
export const CHROME_STORE_LISTED = false;

/** Where "How to install" points: the docs page that explains Load unpacked. */
export const CHROME_INSTALL_DOCS_PATH = '/docs/connect/chrome';

/** Opens Settings → Kortix in Chrome. The link a person copies to open it in Chrome. */
export function chromeSettingsLink(origin: string): string {
  return `${origin}/settings/chrome`;
}

export interface ExtensionStatus {
  version: string;
  /** The extension holds a Kortix sign-in and a browser id. */
  connected: boolean;
  apiUrl: string | null;
  chromeId: string | null;
}

export type ExtensionConnectResult = { ok: true; chromeId: string } | { ok: false; error: string };

interface ChromeRuntime {
  sendMessage: (id: string, message: unknown, reply: (response: unknown) => void) => void;
  lastError?: { message?: string };
}

const PING_TIMEOUT_MS = 1_500;
// Sign-in happens in a Chrome window the person must finish.
const CONNECT_TIMEOUT_MS = 120_000;

/** Chrome, Edge, Brave, Arc and Opera on a computer. Not Electron, not Chrome on iOS. */
export function isChromiumBrowser(userAgent: string): boolean {
  return /Chrome\/\d/.test(userAgent) && !/Electron\//.test(userAgent);
}

/**
 * The API origin the extension signs in to. The web app's backend URL can be
 * root-relative (`/v1`, same-origin deployments), so resolve it against the
 * page. The extension appends `/v1/...` itself. `''` when there is none.
 */
export function apiOrigin(backendUrl: string, pageOrigin: string): string {
  if (!backendUrl) return '';
  try {
    return new URL(backendUrl, pageOrigin).origin;
  } catch {
    return '';
  }
}

function send<T>(message: unknown, timeoutMs: number, parse: (response: unknown) => T | null): Promise<T | null> {
  const runtime = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime;
  if (!runtime?.sendMessage) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const done = (value: T | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    try {
      runtime.sendMessage(KORTIX_EXTENSION_ID, message, (response) => {
        // Reading `lastError` marks it handled. Set when the extension is absent.
        done(runtime.lastError ? null : parse(response));
      });
    } catch {
      done(null);
    }
  });
}

/** The extension's state, or `null`: not installed, not Chromium, or no answer in 1.5 s. */
export function pingExtension(timeoutMs = PING_TIMEOUT_MS): Promise<ExtensionStatus | null> {
  return send({ type: 'kortix.ping' }, timeoutMs, (response) => {
    const r = response as Record<string, unknown> | undefined;
    if (!r || r.ok !== true) return null;
    return {
      version: String(r.version ?? ''),
      connected: r.connected === true,
      apiUrl: typeof r.apiUrl === 'string' ? r.apiUrl : null,
      chromeId: typeof r.chromeId === 'string' ? r.chromeId : null,
    };
  });
}

/** Starts the extension's Kortix sign-in. Resolves when the person finishes it. */
export async function connectExtension(apiUrl: string): Promise<ExtensionConnectResult> {
  const result = await send<ExtensionConnectResult>(
    { type: 'kortix.connect', apiUrl },
    CONNECT_TIMEOUT_MS,
    (response) => {
      const r = response as Record<string, unknown> | undefined;
      if (r?.ok === true) return { ok: true, chromeId: String(r.chromeId ?? '') };
      if (r) return { ok: false, error: typeof r.error === 'string' ? r.error : 'failed' };
      return null;
    },
  );
  return result ?? { ok: false, error: 'unavailable' };
}
