/**
 * Platform detection for the /download page and the per-platform redirect
 * routes.
 *
 * Detection runs on the SERVER, from the request's user-agent header, so the
 * page paints the correct card order and the correct filled button on first
 * render. A client-side `useEffect` swap would let a visitor click the wrong
 * installer during the flash — the exact failure this page exists to prevent.
 *
 * Architecture is deliberately NOT detected: macOS ships a single universal
 * .dmg, and macOS user agents misreport arch anyway (they always claim Intel).
 */

export type DesktopOs = 'macos' | 'windows' | 'linux';
export type MobileOs = 'ios' | 'android';
export type Platform = DesktopOs | MobileOs;

/** Canonical order, used once the detected platform has been hoisted out. */
export const DESKTOP_ORDER: readonly DesktopOs[] = ['macos', 'windows', 'linux'];
export const MOBILE_ORDER: readonly MobileOs[] = ['ios', 'android'];

const PLATFORM_ALIASES: Record<string, Platform> = {
  mac: 'macos',
  macos: 'macos',
  osx: 'macos',
  darwin: 'macos',
  apple: 'macos',
  win: 'windows',
  windows: 'windows',
  linux: 'linux',
  ios: 'ios',
  iphone: 'ios',
  ipad: 'ios',
  android: 'android',
};

/** Map an explicit `?platform=` value or `/download/<segment>` to a platform. */
export function normalizePlatform(raw: string | null | undefined): Platform | null {
  return PLATFORM_ALIASES[(raw || '').toLowerCase()] ?? null;
}

/**
 * Best-effort platform from a user-agent string.
 *
 * THE ORDER OF THESE CHECKS IS LOAD-BEARING. Two user agents carry another
 * platform's token:
 *   iPad     "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"  contains "mac"
 *   Android  "Mozilla/5.0 (Linux; Android 14; Pixel 8)"       contains "linux"
 * So iOS is tested before macOS, and Android before Linux. `detect-os.test.ts`
 * pins both; if you reorder these lines, those tests fail.
 *
 * KNOWN LIMITATION: an iPad with "Request Desktop Website" enabled sends a UA
 * byte-identical to a Mac's. No server can separate them — real detection needs
 * `navigator.maxTouchPoints`, which is not in any request header. That visitor
 * gets the Desktop card first; the Mobile card is still on the page, one tap
 * away. Fixing it client-side would reintroduce the wrong-file-click window
 * this module exists to close.
 *
 * Defaults to macOS: the largest desktop segment for this product, and every
 * other platform stays one click away on the page.
 */
export function detectPlatform(userAgent: string | null | undefined): Platform {
  const ua = (userAgent || '').toLowerCase();
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) return 'ios';
  if (ua.includes('android')) return 'android';
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('mac') || ua.includes('darwin')) return 'macos';
  if (ua.includes('linux')) return 'linux';
  return 'macos';
}

export function isMobilePlatform(platform: Platform): platform is MobileOs {
  return platform === 'ios' || platform === 'android';
}

/**
 * Detected desktop OS first. A phone detection leaves the order canonical.
 *
 * The early return is what narrows `platform` to `DesktopOs` for the spread —
 * `isMobilePlatform` is a type predicate, so no cast is needed here.
 */
export function orderedDesktop(platform: Platform): DesktopOs[] {
  if (isMobilePlatform(platform)) return [...DESKTOP_ORDER];
  return [platform, ...DESKTOP_ORDER.filter((os) => os !== platform)];
}

/** Detected mobile OS first. A desktop detection leaves the order canonical. */
export function orderedMobile(platform: Platform): MobileOs[] {
  if (!isMobilePlatform(platform)) return [...MOBILE_ORDER];
  return [platform, ...MOBILE_ORDER.filter((os) => os !== platform)];
}
