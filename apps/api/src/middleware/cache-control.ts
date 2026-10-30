import type { Context, Next } from 'hono';

/** Credential-bearing and cookie-setting responses must never enter a shared cache. */
export async function protectResponseCache(c: Context, next: Next): Promise<void> {
  await next();

  if (
    !c.req.header('Authorization') &&
    !c.req.header('Cookie') &&
    !c.req.header('X-Kortix-Token') &&
    !c.get('authType') &&
    !c.res.headers.has('set-cookie')
  ) return;

  // CDN-specific directives can override Cache-Control at the edge.
  for (const name of [
    'Cache-Control',
    'CDN-Cache-Control',
    'Cloudflare-CDN-Cache-Control',
    'Surrogate-Control',
  ]) {
    c.header(name, 'private, no-store');
  }
}
