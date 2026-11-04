import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json } from '../../openapi';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { fetchLinkMeta } from '../lib/link-unfurl';

const LinkPreviewSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  site_name: z.string().nullable(),
  image_url: z.string().nullable().openapi({ description: 'The page’s og:image, https only.' }),
}).openapi('LinkPreview');

export function registerLinkPreviewRoutes(): void {
  // GET /v1/projects/:projectId/link-preview?url=
  // A doc's link card: the page's title, description and image. The fetch is
  // the channel links' (`fetchLinkMeta`): public addresses only, 5 s, 256 KB,
  // HTML only, no cookies. A page it cannot read answers nulls, not an error.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/link-preview',
      tags: ['projects'],
      summary: 'Read a web page’s title, description and image for a link card',
      ...auth,
      request: {
        params: z.object({ projectId: z.string().uuid() }),
        query: z.object({ url: z.string().url().max(2048).refine((value) => /^https?:\/\//i.test(value), 'http(s) only') }),
      },
      responses: { 200: json(LinkPreviewSchema, 'The page'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const { projectId } = c.req.valid('param');
      const { url } = c.req.valid('query');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const meta = await fetchLinkMeta(url).catch(() => null);
      return c.json(
        {
          url,
          title: meta?.title ?? null,
          description: meta?.description ?? null,
          site_name: meta?.siteName ?? null,
          image_url: meta?.imageUrl ?? null,
        },
        200,
      );
    },
  );
}
