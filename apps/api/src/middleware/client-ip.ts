import type { Context } from 'hono';
import { clientIpFromHeaders, clientKeyFromHeaders, egressIpFromHeaders } from '../shared/client-ip';

/** `clientIpFromHeaders` for a Hono request; `null` when neither header is set. */
export function requestClientIp(c: Context): string | null {
  return clientIpFromHeaders((name) => c.req.header(name));
}

/** `clientKeyFromHeaders` for a Hono request. */
export function requestClientKey(c: Context): string {
  return clientKeyFromHeaders((name) => c.req.header(name));
}

/**
 * `egressIpFromHeaders` for a Hono request: the address a session credential
 * is pinned to (`platform/services/sandbox-egress-pin.ts`).
 */
export function requestEgressIp(c: Context): string | null {
  return egressIpFromHeaders((name) => c.req.header(name));
}
