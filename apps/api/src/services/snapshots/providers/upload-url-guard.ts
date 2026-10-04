/**
 * Presigned build-context upload URL security (PHASE 2) + log sanitization
 * (PHASE 1.11).
 *
 * The build-context uploader PUTs 100s-of-MB straight to an object-storage URL
 * that Platinum hands back from `/v1/templates/from-build/presign`. That URL is
 * attacker-influenceable in the worst case (a compromised/again-buggy presign
 * response, an MITM, a misconfig), so before we stream bytes to it we assert:
 *
 *   • HTTPS outside explicit local-dev (a plaintext PUT leaks the whole context
 *     + the presigned signature),
 *   • the host is not loopback / link-local / multicast / private / unspecified
 *     (SSRF: a presign response must never make us PUT to an internal address),
 *   • the host is in the configured object-storage allowlist when one is set,
 *   • redirects are refused at fetch time (`redirect: 'error'`) so a 30x can't
 *     bounce the signed PUT to a different origin.
 *
 * And whenever a presigned URL is logged, its query string + fragment are
 * stripped first — the presign signature (and any embedded credential) lives in
 * the query, and it must never reach a log line.
 */

/**
 * Strip the query string and fragment from a URL for safe logging. Presigned
 * URLs carry the signature/token in the query, so only `scheme://host/path` may
 * be logged. Falls back to a defensive prefix-cut for non-URL strings.
 */
export function sanitizeUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    const noFragment = raw.split('#')[0] ?? raw;
    return noFragment.split('?')[0] ?? noFragment;
  }
}

export type IpHostClass =
  | 'loopback'
  | 'link-local'
  | 'multicast'
  | 'private'
  | 'unspecified'
  | 'public'
  | 'not-ip';

/**
 * Classify a hostname that is an IP literal. Non-IP hostnames return
 * `'not-ip'` (they can't be classified without DNS, which this sync guard
 * deliberately does not do). Covers IPv4 dotted-quad, common IPv6 forms, and
 * IPv4-mapped IPv6 (`::ffff:10.0.0.1`).
 */
export function classifyIpHost(host: string): IpHostClass {
  // `URL.hostname` returns IPv6 literals bracketed (`[::1]`); strip them so the
  // classifier sees the bare address.
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');

  // IPv4 dotted quad.
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return 'not-ip';
    return classifyV4(o as [number, number, number, number]);
  }

  // IPv6 (with or without zone id). Only literals — bracket-stripping is done by
  // the URL parser, so we get the bare address here.
  if (h.includes(':')) {
    const addr = h.split('%')[0] ?? h; // drop any zone id
    if (addr === '::1') return 'loopback';
    if (addr === '::' || addr === '') return 'unspecified';
    // IPv4-mapped IPv6 (`::ffff:0:0/96`): classify by the EMBEDDED v4 so a mapped
    // metadata/loopback/private address can't sneak past the guard.
    //
    // Two serializations reach us: the DOTTED form the user typed
    // (`::ffff:169.254.169.254`) and — crucially — the COMPRESSED HEX form Node's
    // WHATWG URL serializer emits from `new URL(...).hostname`
    // (`::ffff:a9fe:a9fe`, `::ffff:7f00:1`, `::ffff:a00:1`, …). The old code only
    // matched the dotted form, so every hex-serialized mapped address (i.e. every
    // one that actually comes through a parsed URL) fell through to `public` and
    // the SSRF guard allowed a PUT to the cloud metadata service. Handle BOTH.
    const mappedV4 = parseMappedV4(addr);
    if (mappedV4) return classifyV4(mappedV4);
    if (addr.startsWith('fe80')) return 'link-local';
    if (addr.startsWith('ff')) return 'multicast';
    // Unique-local fc00::/7 → fc.. or fd..
    if (/^f[cd]/.test(addr)) return 'private';
    return 'public';
  }

  return 'not-ip';
}

/**
 * Extract the embedded 32-bit IPv4 from an IPv4-mapped IPv6 address
 * (`::ffff:0:0/96`), in EITHER serialization, or null if `addr` is not mapped:
 *   • dotted:       `::ffff:169.254.169.254`      → [169,254,169,254]
 *   • compressed hex `::ffff:a9fe:a9fe` (two trailing hextets → 32 bits):
 *       a9fe:a9fe → 0xa9fe,0xa9fe → 169.254 . 169.254
 *       7f00:1    → 0x7f00,0x0001 → 127.0   . 0.1     (127.0.0.1)
 *       a00:1     → 0x0a00,0x0001 → 10.0    . 0.1     (10.0.0.1)
 * The hex form is what `new URL(...).hostname` actually produces, so it is the
 * form that matters for a real SSRF attempt.
 */
function parseMappedV4(addr: string): [number, number, number, number] | null {
  const dotted = addr.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const o = dotted.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    return o as [number, number, number, number];
  }
  const hex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }
  return null;
}

function classifyV4(o: [number, number, number, number]): IpHostClass {
  const [a, b] = o;
  if (a === 127) return 'loopback';
  if (a === 0) return 'unspecified';
  if (a === 169 && b === 254) return 'link-local'; // 169.254.0.0/16 (incl. cloud metadata 169.254.169.254)
  if (a >= 224 && a <= 239) return 'multicast';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT 100.64.0.0/10
  return 'public';
}

export interface UploadUrlGuardOpts {
  /** Local dev: allow http + loopback/private hosts (e.g. MinIO on localhost). */
  allowLocal?: boolean;
  /**
   * Configured object-storage origins — a hostname matches when it equals an
   * entry or is a subdomain of it. When empty/undefined the allowlist check is
   * skipped and only the scheme + SSRF checks apply (so an un-configured prod
   * still uploads, just without origin-pinning).
   */
  allowedHosts?: string[];
}

/**
 * Assert a presigned upload URL is safe to stream a build context to. Returns
 * the parsed URL on success; throws a descriptive, credential-free error
 * otherwise (the message never includes the query string).
 */
export function assertSafePresignedUploadUrl(raw: string, opts: UploadUrlGuardOpts = {}): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('presigned upload URL is not a valid URL');
  }
  const host = u.hostname.toLowerCase();
  const safe = sanitizeUrlForLog(raw);

  // Scheme: https required outside explicit local-dev.
  if (u.protocol !== 'https:' && !(opts.allowLocal && u.protocol === 'http:')) {
    throw new Error(`presigned upload URL must use https (got ${safe})`);
  }

  // SSRF: never PUT to an internal address unless local-dev explicitly allows it.
  if (!opts.allowLocal) {
    const isLoopbackName = host === 'localhost' || host.endsWith('.localhost');
    const ipClass = classifyIpHost(host);
    if (isLoopbackName || ['loopback', 'link-local', 'multicast', 'private', 'unspecified'].includes(ipClass)) {
      throw new Error(`presigned upload URL host is not routable/allowed (${safe})`);
    }
  }

  // Origin pinning: when an allowlist is configured, the host must match it.
  const allow = (opts.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allow.length > 0) {
    const ok = allow.some((h) => host === h || host.endsWith(`.${h}`));
    if (!ok) {
      throw new Error(`presigned upload URL host ${host} is not in the configured object-storage allowlist`);
    }
  }

  return u;
}

/** Parse the comma/space-separated object-storage host allowlist env var. */
export function parseUploadHostAllowlist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,\s]+/)
    .map((h) => h.trim())
    .filter(Boolean);
}
