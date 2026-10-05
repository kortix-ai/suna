import type { Context } from 'hono';
import { clientIpFromHeaders, clientKeyFromHeaders } from '../shared/client-ip';

/** `clientIpFromHeaders` for a Hono request; `null` when neither header is set. */
export function requestClientIp(c: Context): string | null {
  return clientIpFromHeaders((name) => c.req.header(name));
}

/** `clientKeyFromHeaders` for a Hono request. */
export function requestClientKey(c: Context): string {
  return clientKeyFromHeaders((name) => c.req.header(name));
}
