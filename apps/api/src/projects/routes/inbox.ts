// ─── Automation Inbox ───────────────────────────────────────────────────────
// Per-project, per-user awareness feed (gated by the `inbox` experimental flag).

import { createRoute, z } from '@hono/zod-openapi';
import { resolveExperimentalFeature } from '../../experimental/features';
import {
  countUnreadForUser,
  listInboxForUser,
  markInboxRead,
  serializeInboxItem,
} from '../../inbox/inbox-items';
import { auth, errors, json } from '../../openapi';
import { loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { readBody } from '../lib/serializers';

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/inbox',
    tags: ['inbox'],
    summary: 'GET /:projectId/inbox',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      query: z.object({}).passthrough(),
    },
    responses: {
      200: json(
        z.object({ items: z.array(AnyObject), unread_count: z.number() }),
        'Inbox items for the caller',
      ),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (!resolveExperimentalFeature(loaded.row.metadata, 'inbox')) {
      return c.json({ error: 'Not found' }, 404);
    }

    const filter = String(c.req.query('filter') ?? 'all').toLowerCase();
    if (filter !== 'all' && filter !== 'unread') {
      return c.json({ error: 'filter must be all or unread' }, 400);
    }

    const [rows, unreadCount] = await Promise.all([
      listInboxForUser(projectId, loaded.userId, { unreadOnly: filter === 'unread' }),
      countUnreadForUser(projectId, loaded.userId),
    ]);
    return c.json({ items: rows.map(serializeInboxItem), unread_count: unreadCount });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/inbox/read',
    tags: ['inbox'],
    summary: 'POST /:projectId/inbox/read',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(z.object({ updated: z.number(), unread_count: z.number() }), 'Marked read'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    if (!resolveExperimentalFeature(loaded.row.metadata, 'inbox')) {
      return c.json({ error: 'Not found' }, 404);
    }

    const body = await readBody(c);
    const itemIds = Array.isArray(body.item_ids)
      ? body.item_ids.filter((v: unknown): v is string => typeof v === 'string')
      : undefined;
    const sessionId = typeof body.session_id === 'string' ? body.session_id : undefined;
    const all = body.all === true;
    if (!itemIds?.length && !sessionId && !all) {
      return c.json({ error: 'Provide item_ids, session_id, or all: true' }, 400);
    }

    const updated = await markInboxRead(projectId, loaded.userId, { itemIds, sessionId, all });
    const unreadCount = await countUnreadForUser(projectId, loaded.userId);
    return c.json({ updated, unread_count: unreadCount });
  },
);
