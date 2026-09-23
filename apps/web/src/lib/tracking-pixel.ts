import { DESKTOP_UA_TOKEN } from '@/lib/desktop';

export const VISITOR_PIXEL_SRC =
  'https://d2mvefebd70kbz.cloudfront.net/scripts/019e82ba-9ec3-733e-8a8e-9ff5cc2e1d35.js';

/**
 * True when the visitor pixel may load: the real site host (kortix.com or a
 * subdomain), and not the desktop app. Mirrors `VISITOR_PIXEL_SCRIPT`.
 */
export function shouldLoadVisitorPixel(hostname: string, userAgent: string): boolean {
  if (userAgent.includes(DESKTOP_UA_TOKEN)) return false;
  const host = hostname.toLowerCase();
  return host === 'kortix.com' || host.endsWith('.kortix.com');
}

/**
 * Inline loader for the domain-verification / visitor pixel.
 *
 * The page HTML is static, so the host and user-agent gate runs in the browser,
 * before the script element exists. It skips the desktop app (third-party
 * de-anonymization has no place in the authenticated native client) and every
 * host except kortix.com and its subdomains (CI, local dev, and preview deploys:
 * the vendor 400s their beacons, which failed the admin console's
 * "no bad responses" browser guard).
 */
export const VISITOR_PIXEL_SCRIPT = `
(function() {
  try {
    var ua = navigator.userAgent || '';
    if (ua.indexOf('${DESKTOP_UA_TOKEN}') !== -1) return;
    var host = (location.hostname || '').toLowerCase();
    if (host !== 'kortix.com' && !/\\.kortix\\.com$/.test(host)) return;
    var s = document.createElement('script');
    s.src = '${VISITOR_PIXEL_SRC}';
    s.async = true;
    s.crossOrigin = 'anonymous';
    document.head.appendChild(s);
  } catch (e) {}
})();
`.trim();
