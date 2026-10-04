import type { Context } from 'hono';
import { clientIpFromHeaders, clientKeyFromHeaders } from '../../lib/client-ip';
import { egressIpFromHeaders } from '../../services/platform/services/sandbox-egress-pin';

/** `clientIpFromHeaders` for a Hono request; `null` when neither header is set. */
export function requestClientIp(c: Context): string | null {
  return clientIpFromHeaders((name) => c.req.header(name));
}

/** `clientKeyFromHeaders` for a Hono request. */
export function requestClientKey(c: Context): string {
  return clientKeyFromHeaders((name) => c.req.header(name));
}

/** `egressIpFromHeaders` for a Hono request: the sandbox egress address the pin compares. */
export function requestEgressIp(c: Context): string | null {
  return egressIpFromHeaders((name) => c.req.header(name));
}
