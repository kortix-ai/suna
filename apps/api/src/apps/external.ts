/**
 * External Apps: an App hosted elsewhere that Kortix lists and frames by URL
 * (`apps.external_url`). Kortix never deploys, wakes or bills it.
 */
import { safeEgressFetch } from '../shared/ssrf-guard';

/** `source` (a CSP host source such as `https://*.kortix.com`) matches `origin`. */
function sourceMatches(source: string, origin: URL): boolean {
  const match = /^(?:(https?):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?/.exec(source);
  if (!match) return false;
  const [, scheme, wildcard, host] = match;
  if (scheme && `${scheme}:` !== origin.protocol) return false;
  return wildcard ? origin.hostname.endsWith(`.${host}`) : origin.hostname === host;
}

/**
 * Do these response headers let `frameOrigin` frame the page? CSP
 * `frame-ancestors` wins over `X-Frame-Options` (a browser ignores XFO when
 * the CSP sets it), and every CSP policy in the header must allow it.
 */
export function allowsFraming(headers: Headers, frameOrigin: string): boolean {
  const origin = new URL(frameOrigin);
  const policies = (headers.get('content-security-policy') ?? '').split(',');
  let ancestorsSet = false;
  for (const policy of policies) {
    const directive = policy.split(';').map((part) => part.trim().split(/\s+/))
      .find(([name]) => name?.toLowerCase() === 'frame-ancestors');
    if (!directive) continue;
    ancestorsSet = true;
    const sources = directive.slice(1).map((source) => source.toLowerCase());
    const allowed = sources.some((source) =>
      source === '*' || source === `${origin.protocol}` || (!source.startsWith("'") && sourceMatches(source, origin)));
    if (!allowed) return false;
  }
  if (ancestorsSet) return true;
  const xfo = headers.get('x-frame-options')?.trim().toLowerCase();
  return xfo !== 'deny' && xfo !== 'sameorigin';
}

/**
 * Read whether `frameOrigin` (the web app) may frame `url`. One GET, 5 s, through the SSRF
 * guard. A site the API cannot reach (a private address, a timeout) counts as
 * frameable: the viewer's browser may reach what the API cannot, and the App
 * view keeps an "open in a new tab" control for the frame that stays blank.
 */
export async function probeFrameable(url: string, frameOrigin: string): Promise<boolean> {
  try {
    const response = await safeEgressFetch(url, { signal: AbortSignal.timeout(5_000), headers: { accept: 'text/html' } });
    await response.body?.cancel();
    return allowsFraming(response.headers, frameOrigin);
  } catch {
    return true;
  }
}
