import type { Context } from 'hono';
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

/** `clientIpFromHeaders` for a Hono request; `null` when neither header is set. */
export function requestClientIp(c: Context): string | null {
  return clientIpFromHeaders((name) => c.req.header(name));
}

/**
 * The caller's rate-limit bucket key: the client address, or `'unknown'` when
 * neither header is set. Every request without an address shares that one
 * bucket. Stored rows use `requestClientIp`, which keeps `null`.
 */
export function clientKeyFromHeaders(header: HeaderReader): string {
  return clientIpFromHeaders(header) ?? 'unknown';
}

/** `clientKeyFromHeaders` for a Hono request. */
export function requestClientKey(c: Context): string {
  return clientKeyFromHeaders((name) => c.req.header(name));
}
