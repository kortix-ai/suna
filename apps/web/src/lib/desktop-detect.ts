/**
 * Desktop shell detection from the user agent. No env, no window helpers:
 * shared UI imports it without the rest of `lib/desktop.ts`.
 */

export const DESKTOP_UA_TOKEN = 'KortixDesktop';

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
