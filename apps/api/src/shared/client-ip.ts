import { config } from '../config';

/**
 * The caller's address, for rate limiting and for the address recorded in
 * audit, session-activity, and IAM request-context rows.
 *
 * `X-Forwarded-For` is a list that every proxy APPENDS to. The client writes
 * whatever it likes into the header first, so the LEFTMOST entry is chosen by
 * the caller and never identifies it. Reading it gave every request a fresh
 * rate-limit bucket for the price of a random header.
 *
 * The rule: the client is the entry `KORTIX_TRUSTED_PROXY_HOPS` places from the
 * RIGHT. Each trusted proxy appended exactly one entry, so the entries to the
 * right of the client were written by infrastructure and the entries to its
 * left were written by the client.
 *
 *   Cloud (Cloudflare, then the ALB, both append):  [spoofed…, client, cf-edge]
 *   hops = 2 → `client`.
 *
 *   Self-host (Caddy replaces an untrusted header):  [client]
 *   A chain shorter than `hops` holds only proxy-written entries, so its
 *   leftmost entry is the client.
 *
 * A wrong hop count degrades in one of two directions. Too low: the caller is a
 * proxy address, so many clients share one bucket. Too high: the caller is a
 * client-written entry, which is the old behaviour. Neither is a new exposure.
 */
export function trustedProxyHops(): number {
  const hops = Number((config as { KORTIX_TRUSTED_PROXY_HOPS?: unknown }).KORTIX_TRUSTED_PROXY_HOPS);
  return Number.isInteger(hops) && hops >= 1 ? hops : 2;
}

type HeaderReader = (name: string) => string | null | undefined;

export function clientIpFromHeaders(
  header: HeaderReader,
  hops: number = trustedProxyHops(),
): string | null {
  const chain = (header('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (chain.length > 0) {
    return chain[Math.max(0, chain.length - Math.max(1, hops))] ?? null;
  }
  return header('x-real-ip')?.trim() || null;
}

/**
 * The caller's rate-limit bucket key: the client address, or `'unknown'` when
 * neither header is set. Every request without an address shares that one
 * bucket. Stored rows use `requestClientIp`, which keeps `null`.
 */
export function clientKeyFromHeaders(header: HeaderReader): string {
  return clientIpFromHeaders(header) ?? 'unknown';
}

/**
 * The caller's address as this deployment sees it, from its request headers.
 *
 * `cf-connecting-ip` is read FIRST because the edge OVERWRITES it on every
 * request. `x-forwarded-for` is not overwritten — Cloudflare appends to what
 * the client sent, so its first hop is attacker-controlled. A caller who
 * exfiltrated a session token can therefore set `x-forwarded-for` to the pinned
 * sandbox address and replay the token from anywhere; they cannot forge
 * `cf-connecting-ip`. The xff/x-real-ip fallback stays for deployments that do
 * not sit behind Cloudflare.
 */
export function egressIpFromHeaders(header: HeaderReader): string | null {
  const cf = header('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const xff = header('x-forwarded-for');
  const first = xff ? xff.split(',')[0]?.trim() : undefined;
  return first || header('x-real-ip')?.trim() || null;
}
