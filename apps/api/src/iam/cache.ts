// Request-context derivation shared by IAM callers.

import type { Context } from 'hono';
import type { RequestContext } from './engine';

/**
 * Derive the request context (IP + MFA AAL) from a Hono Context. The IP
 * comes from x-forwarded-for (first hop) or x-real-ip — both set by the
 * upstream proxy. mfaAal is populated by supabaseAuth from the JWT.
 *
 * Folded into the cache key so two requests under the same user but with
 * different IPs / AAL never share an authorize() result — important when
 * policies condition on either.
 */
export function deriveRequestContext(c: Context): RequestContext {
  const xff = c.req.header('x-forwarded-for');
  // First hop in x-forwarded-for is the original client; the rest are
  // intermediate proxies. Trim whitespace because some proxies add it.
  const ip = xff
    ? xff.split(',')[0]?.trim() || undefined
    : c.req.header('x-real-ip') || undefined;
  const mfaAal = c.get('mfaAal') as string | undefined;
  return { ip, mfaAal };
}
