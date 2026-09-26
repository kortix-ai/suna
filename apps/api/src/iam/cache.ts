// Request-context derivation shared by IAM callers.

import type { Context } from 'hono';
import { requestClientIp } from '../shared/client-ip';
import type { RequestContext } from './actor';

/**
 * Derive the request context (IP + MFA AAL) from a Hono Context. The IP
 * follows the trusted-proxy rule in shared/client-ip.ts. mfaAal is populated
 * by supabaseAuth from the JWT.
 *
 * Folded into the cache key so two requests under the same user but with
 * different IPs / AAL never share an authorize() result — important when
 * policies condition on either.
 */
export function deriveRequestContext(c: Context): RequestContext {
  const ip = requestClientIp(c) ?? undefined;
  const mfaAal = c.get('mfaAal') as string | undefined;
  return { ip, mfaAal };
}
