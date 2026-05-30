// CIDR matching for IAM policy conditions. Supports IPv4 and IPv6, mapped
// IPv4-in-IPv6 (::ffff:1.2.3.4), and bare IPs treated as /32 or /128.
//
// Zero deps on purpose — Bun/Node have no built-in matcher, and the rules
// are small enough to be obvious. All inputs are admin-supplied via the
// policy editor and re-validated before persistence in parseCidr().

type Parsed = {
  family: 4 | 6;
  /** Big integer-encoded address. We use bigint for both families so the
   *  match path is a single mask + equality check. */
  addr: bigint;
  /** Prefix length in bits. /32 for bare v4, /128 for bare v6. */
  prefix: number;
};

const V4_BITS = 32;
const V6_BITS = 128;

/**
 * Parse a CIDR string ("10.0.0.0/8", "2001:db8::/32") or a bare IP. Returns
 * null for anything malformed. Throws are reserved for the
 * validate-on-write helper below so the matcher itself can be infallible
 * and called from the hot path without try/catch.
 */
export function parseCidr(input: string): Parsed | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const slash = trimmed.indexOf('/');
  const ipPart = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const prefixPart = slash === -1 ? null : trimmed.slice(slash + 1);

  const v4 = parseIpv4(ipPart);
  if (v4 !== null) {
    const prefix = prefixPart === null ? V4_BITS : parseInt(prefixPart, 10);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > V4_BITS) return null;
    return { family: 4, addr: v4, prefix };
  }

  const v6 = parseIpv6(ipPart);
  if (v6 !== null) {
    const prefix = prefixPart === null ? V6_BITS : parseInt(prefixPart, 10);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > V6_BITS) return null;
    return { family: 6, addr: v6, prefix };
  }

  return null;
}

/** Validate input. Returns the original string on success, throws on bad input. */
export function assertValidCidr(input: string): string {
  const parsed = parseCidr(input);
  if (!parsed) throw new Error(`invalid CIDR or IP: ${input}`);
  return input.trim();
}

/**
 * True if `ip` (a string, e.g. from x-forwarded-for) falls within any of
 * the supplied CIDRs. Pre-parse the CIDR list once with parseCidr; we
 * accept the parsed form to keep the match loop allocation-free.
 */
export function ipMatchesAny(ip: string, cidrs: readonly Parsed[]): boolean {
  if (cidrs.length === 0) return false;
  const stripped = stripV4Mapped(ip);
  const parsedV4 = parseIpv4(stripped);
  const parsedV6 = parsedV4 === null ? parseIpv6(stripped) : null;
  for (const cidr of cidrs) {
    if (cidr.family === 4 && parsedV4 !== null) {
      if (inRange(parsedV4, cidr.addr, cidr.prefix, V4_BITS)) return true;
    } else if (cidr.family === 6 && parsedV6 !== null) {
      if (inRange(parsedV6, cidr.addr, cidr.prefix, V6_BITS)) return true;
    }
  }
  return false;
}

function inRange(addr: bigint, network: bigint, prefix: number, total: number): boolean {
  if (prefix === 0) return true; // /0 matches everything
  const shift = BigInt(total - prefix);
  return (addr >> shift) === (network >> shift);
}

function parseIpv4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let acc = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = parseInt(p, 10);
    if (n < 0 || n > 255) return null;
    acc = (acc << 8n) | BigInt(n);
  }
  return acc;
}

function parseIpv6(s: string): bigint | null {
  if (!s.includes(':')) return null;
  // Reject odd characters early so we don't waste time on full parse.
  if (!/^[0-9a-fA-F:]+$/.test(s)) return null;

  const doubleColonIdx = s.indexOf('::');
  let groups: string[];
  if (doubleColonIdx === -1) {
    groups = s.split(':');
    if (groups.length !== 8) return null;
  } else {
    if (s.indexOf('::', doubleColonIdx + 2) !== -1) return null; // multiple ::
    const before = s.slice(0, doubleColonIdx).split(':').filter((g) => g.length > 0);
    const after = s.slice(doubleColonIdx + 2).split(':').filter((g) => g.length > 0);
    const fill = 8 - before.length - after.length;
    if (fill < 0) return null;
    groups = [...before, ...new Array(fill).fill('0'), ...after];
    if (groups.length !== 8) return null;
  }

  let acc = 0n;
  for (const g of groups) {
    if (g.length === 0 || g.length > 4) return null;
    const n = parseInt(g, 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
    acc = (acc << 16n) | BigInt(n);
  }
  return acc;
}

/** "::ffff:1.2.3.4" → "1.2.3.4". Trims the IPv4-mapped IPv6 prefix so
 *  IPv4 CIDRs match traffic coming through a v6 socket. */
function stripV4Mapped(ip: string): string {
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : ip;
}
