import type { Context } from 'hono';
import type { RequestContext } from './types';

/**
 * Derive the request context (IP + MFA AAL) from a Hono Context. The IP
 * comes from x-forwarded-for (first hop) or x-real-ip — both set by the
 * upstream proxy. mfaAal is populated by supabaseAuth from the JWT.
 *
 * Folded into the cache key so two requests under the same user but with
 * different IPs / AAL never share an authorize() result. V2 currently uses
 * AAL for account-wide MFA; IP is retained in the contract for callers that
 * already derive a full request context.
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
