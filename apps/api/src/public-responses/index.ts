/**
 * Anonymous, read-only view of one shared assistant response —
 * `GET /v1/public/responses/:token`. Backs the web page `/share/response/:token`.
 *
 * The token is the bearer capability (`kps_` + 128 random bits). The answer is
 * ONLY the stored snapshot: no session id, project id, prompt, or sandbox
 * access. The snapshot is built at share time from the session log
 * (`projects/lib/response-snapshot.ts`); this route reads one row by token hash.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { errors, json, makeOpenApiApp } from '../openapi';
import { createPublicResponseRateLimitMiddleware } from '../middleware/rate-limit';
import { readPublicResponse } from '../shared/session-public-shares';

export const publicResponsesApp = makeOpenApiApp();

const PublicResponseSchema = z.object({
  title: z.string(),
  prompt: z.string().nullable(),
  markdown: z.string(),
  agent_name: z.string().nullable(),
  model_id: z.string().nullable(),
  responded_at: z.string(),
  shared_at: z.string(),
});

export function registerPublicResponseRoutes(): void {
  publicResponsesApp.use('/:token', createPublicResponseRateLimitMiddleware());
  publicResponsesApp.openapi(
    createRoute({
      method: 'get',
      path: '/{token}',
      tags: ['public-responses'],
      summary: 'View a shared assistant response (anonymous)',
      request: { params: z.object({ token: z.string().min(1).max(200) }) },
      responses: {
        200: json(z.object({ response: PublicResponseSchema }), 'The shared response'),
        ...errors(404, 410),
      },
    }),
    async (c) => {
      const result = await readPublicResponse(c.req.valid('param').token);
      if (!result.ok) return c.json({ error: result.error }, result.status);
      // Revocation reaches a cached copy within 60 s.
      c.header('Cache-Control', 'public, max-age=60');
      return c.json({ response: result.response }, 200);
    },
  );
}
