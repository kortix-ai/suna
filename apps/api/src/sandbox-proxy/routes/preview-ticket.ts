import { createRoute, z } from '@hono/zod-openapi';
import { makeOpenApiApp, json, auth, ErrorSchema } from '../../openapi';
import { bearerToken } from '../../shared/bearer-token';
import { resolvePreviewHost } from '../preview-hosts';
import { establishPreviewSession } from '../preview-origin';
import { mintPreviewSession } from '../preview-session';

export const previewTicket = makeOpenApiApp();

previewTicket.openapi(createRoute({
  method: 'post', path: '/', tags: ['preview'],
  summary: 'Exchange a bearer credential for a 60-second scoped preview navigation ticket',
  ...auth,
  responses: {
    200: json(z.object({ ticket: z.string() }), 'Scoped navigation ticket'),
    400: json(ErrorSchema, 'Invalid preview URL'),
    401: json(ErrorSchema, 'Unauthorized'),
  },
}), async (c) => {
  const token = bearerToken(c.req.header('Authorization'));
  if (!token) return c.json({ error: 'Missing Authorization header' }, 401);
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('preview_url' in body) || typeof body.preview_url !== 'string') {
    return c.json({ error: 'preview_url is required' }, 400);
  }
  let url: URL;
  try { url = new URL(body.preview_url); } catch { return c.json({ error: 'Invalid preview URL' }, 400); }
  const target = resolvePreviewHost(url.host);
  if (!target || !['http:', 'https:'].includes(url.protocol)) return c.json({ error: 'Unknown preview origin' }, 400);
  const request = new Request(url.origin, { headers: { Authorization: `Bearer ${token}` } });
  const result = await establishPreviewSession(request, new URL(url.origin), target);
  if ('refusal' in result) return c.json({ error: result.refusal.message }, 401);
  const { exp: _exp, ...payload } = result.session;
  c.header('Cache-Control', 'no-store');
  return c.json({ ticket: mintPreviewSession(payload, 60) }, 200);
});
