import { DESKTOP_URL_SCHEME, isDesktop } from '@/lib/desktop';

// Kept for backwards-compat with the legacy Electron shell. The current
// desktop app is Tauri-based; both shells share the same `kortix://` scheme.
const ELECTRON_PROTOCOL = DESKTOP_URL_SCHEME;

/**
 * True when running inside a desktop shell (Tauri or legacy Electron).
 * Browser usage returns false. The function name is preserved for legacy
 * call sites — semantically this means "is desktop app".
 */
export function isElectron(): boolean {
  if (typeof window === 'undefined') return false;

  // New Tauri shell uses the unified `KortixDesktop` UA token.
  if (isDesktop()) return true;

  // Legacy Electron detection (kept so an old build still authenticates).
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    if (navigator.userAgent.toLowerCase().includes('electron')) return true;
  }
  // @ts-expect-error - Electron renderer process global
  if (window.process && window.process.type === 'renderer') return true;

  return false;
}

/**
 * Gets the auth callback URL for the current environment
 * - Web: returns the web URL (https://kortix.com/auth/callback)
 * - Electron: returns the custom protocol URL (kortix://auth/callback)
 */
export function getAuthCallbackUrl(returnUrl?: string, termsAccepted?: boolean): string {
  const params = new URLSearchParams();
  if (returnUrl) params.set('returnUrl', returnUrl);
  if (termsAccepted) params.set('terms_accepted', 'true');
  
  const queryString = params.toString();
  const callbackPath = `auth/callback${queryString ? `?${queryString}` : ''}`;
  
  if (isElectron()) {
    // Use custom protocol for Electron - this will open the app
    return `${ELECTRON_PROTOCOL}://${callbackPath}`;
  }
  
  // Web - use standard origin
  if (typeof window !== 'undefined') {
    return `${window.location.origin}/${callbackPath}`;
  }
  
  return `/${callbackPath}`;
}

/**
 * Gets the origin to use for auth redirects
 * - Web: returns window.location.origin
 * - Electron: returns the custom protocol
 */
export function getAuthOrigin(): string {
  if (isElectron()) {
    return `${ELECTRON_PROTOCOL}://`;
  }
  
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  
  return '';
}
