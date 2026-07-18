/**
 * SSRF egress guard — DNS-resolving replacement for the old hostname-string
 * `isPrivateHost` regex.
 *
 * The previous guard (`marketplace/catalog.ts:isPrivateHost`) only string-matched
 * the hostname, so a public domain that DNS-resolves to a private/link-local/
 * cloud-metadata IP (DNS-rebinding) passed the check and was then fetched with
 * the server's network position. This module resolves the hostname at fetch
 * time and rejects any resolved address in a private/reserved range, then
 * follows redirects manually with per-hop re-validation so a 30x to
 * `http://169.254.169.254/` is also blocked.
 *
 * Used by every external-URL egress site that takes a caller-influenced URL:
 * executor spec/route/graphql/mcp fetches, marketplace source add, and
 * audit-webhook delivery. See F-1 (weekly pentest, runs #1–#4) and
 * https://github.com/kortix-ai/suna/issues/4442.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UnsafeEgressError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'UnsafeEgressError';
  }
}

const MAX_REDIRECTS = 5;

/**
 * True if a parsed IP address (v4 or v6 string) is in a private / reserved /
 * link-local / cloud-metadata range that an egress fetch must never reach.
 *
 * Handles decimal/octal/hex IPv4 encodings indirectly: callers pass the value
 * returned by `dns.lookup` (a canonical IP), so encodings are normalized before
 * this runs. IPv4-mapped IPv6 (`::ffff:7f00:1`) is unwrapped and checked as v4.
 */
export function isPrivateIp(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return true;
  const family = isIP(ip);
  if (family === 0) return true; // not an IP → treat as unsafe (defensive)

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) → unwrap to the v4 form.
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return isPrivateIp(mapped[1]);

  if (family === 4) {
    const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // loopback 127/8
    if (a === 169 && b === 254) return true; // link-local + cloud metadata 169.254/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT (not public-routable)
    if (a === 192 && b === 0 && parts[2] === 2) return true; // 192.0.2/24 TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
    if (a === 198 && b === 51 && parts[2] === 100) return true; // 198.51.100/24 TEST-NET-2
    if (a === 203 && b === 0 && parts[2] === 113) return true; // 203.0.113/24 TEST-NET-3
    if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, 255/8 broadcast
    return false;
  }

  // IPv6
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true; // loopback / unspecified
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // fc00::/7 ULA (incl. AWS fd00:ec2::254 metadata)
  if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb'))
    return true; // fe80::/10 link-local
  if (v.startsWith('ff')) return true; // ff00::/8 multicast
  if (v.startsWith('64:ff9b:')) return true; // NAT64 well-known prefix
  if (v.startsWith('100::')) return true; // discard prefix
  if (v.startsWith('2001:db8:')) return true; // documentation
  return false;
}

/**
 * Resolve a URL's hostname and throw `UnsafeEgressError` if ANY resolved address
 * is private/reserved. Returns the validated URL (unchanged) on success.
 *
 * The check is at-resolution-time, so it catches DNS-rebinding from a public IP
 * (checked earlier) to a private IP (resolved now). A residual TOCTOU window
 * between resolve and connect exists (mitigated by the OS resolver cache); to
 * fully close it, a connect-time IP pin would be needed, which Bun's fetch does
 * not expose. This is the standard production SSRF posture and a strict
 * improvement over the prior hostname-string regex.
 */
export async function assertSafeEgressUrl(
  rawUrl: string,
  opts: { allowHttp?: boolean } = {},
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeEgressError('invalid url', rawUrl);
  }
  if (parsed.protocol !== 'https:' && !(opts.allowHttp && parsed.protocol === 'http:')) {
    throw new UnsafeEgressError('url must be https', rawUrl);
  }
  // No userinfo (reject `https://user:pass@host/` egress — leaks creds).
  if (parsed.username || parsed.password) {
    throw new UnsafeEgressError('url must not contain credentials', rawUrl);
  }
  const host = parsed.hostname;
  // Literal IP host → check directly without DNS.
  if (isIP(host) !== 0) {
    if (isPrivateIp(host)) throw new UnsafeEgressError(`blocked private ip host: ${host}`, rawUrl);
    return parsed;
  }
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await dnsLookup(host, { all: true });
  } catch (err) {
    throw new UnsafeEgressError(
      `dns resolution failed for ${host}: ${(err as Error).message}`,
      rawUrl,
    );
  }
  if (resolved.length === 0) {
    throw new UnsafeEgressError(`no dns records for ${host}`, rawUrl);
  }
  for (const r of resolved) {
    if (isPrivateIp(r.address)) {
      throw new UnsafeEgressError(
        `blocked egress to private/resolved address ${r.address} for ${host}`,
        rawUrl,
      );
    }
  }
  return parsed;
}

interface SafeFetchInit extends RequestInit {
  /** Allow http: in addition to https:. Defaults to false. */
  allowHttp?: boolean;
}

/**
 * Fetch a caller-influenced URL safely: validate the URL via
 * {@link assertSafeEgressUrl}, then fetch with `redirect: 'manual'` and
 * re-validate every redirect Location (cap {@link MAX_REDIRECTS}). Any
 * non-2xx/3xx final response is returned as-is for the caller to handle.
 */
export async function safeEgressFetch(
  rawUrl: string,
  init: SafeFetchInit = {},
): Promise<Response> {
  const { allowHttp, ...fetchInit } = init;
  let url = await assertSafeEgressUrl(rawUrl, { allowHttp });
  let hops = 0;
  // Caller-provided signal must propagate to every hop.
  const signal = fetchInit.signal;
  for (;;) {
    const res = await fetch(url, { ...fetchInit, redirect: 'manual', signal });
    if (res.status < 300 || res.status >= 400) return res;
    // 3xx — follow manually with re-validation.
    if (++hops > MAX_REDIRECTS) {
      throw new UnsafeEgressError(`too many redirects (>${MAX_REDIRECTS})`, rawUrl);
    }
    const location = res.headers.get('location');
    if (!location) return res; // malformed 3xx with no Location → let caller see it
    const next = new URL(location, url);
    url = await assertSafeEgressUrl(next.href, { allowHttp });
  }
}
