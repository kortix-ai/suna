// Custom protocol scheme for Electron deep linking
const ELECTRON_PROTOCOL = 'kortix';

/**
 * Detects if the app is running in Electron (desktop app) vs web browser
 */
export function isElectron(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  // Check user agent for Electron (we append "Electron/Kortix-Desktop" in main.js)
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    return navigator.userAgent.toLowerCase().includes('electron');
  }

  // Check for Electron-specific globals
  if (typeof window !== 'undefined') {
    // @ts-expect-error - Electron may inject these
    return !!(window.process && window.process.type === 'renderer');
  }

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
