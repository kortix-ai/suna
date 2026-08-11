/**
 * dosco Apps already provide their own signed edge, lifecycle page, access
 * exchange, and iframe policy. Keep these URLs on their direct origin. Routing
 * them through a session's generic web forward proxy breaks host-only access
 * cookies and adds one avoidable network hop.
 */
export function isdoscoAppUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return host === 'apps.dosco.live' ||
      host.endsWith('.apps.dosco.live') ||
      host.endsWith('.apps.localhost');
  } catch {
    return false;
  }
}
