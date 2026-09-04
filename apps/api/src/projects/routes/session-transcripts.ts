/**
 * Session transcript reads.
 */

import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { createRoute, z } from '@hono/zod-openapi';
import { loadProjectForUser, loadVisibleSession, assertProjectCapability } from '../lib/access';
import { callerKortixSessionId } from '../lib/caller-session';
import { AnyObject, projectsApp } from '../lib/app';
import { UUID_V4_REGEX, parseBoundedPositiveInt } from '../lib/serializers';
import {
  buildSessionTranscriptDigest,
  buildSessionTranscriptSyncEnvelope,
} from '../lib/session-transcript';

// GET /v1/projects/:projectId/sessions/:sessionId/transcript
// Compact server-side transcript read for project automation. Unlike the raw
// /v1/p sandbox proxy, this endpoint is callable with project-scoped session
// tokens and strips tool inputs/outputs before returning messages.
//
// Two shapes, one route. `shape=compact` (the default, unchanged for every
// existing caller) returns the digest rows. `shape=sync` returns OpenCode
// message envelopes verbatim — the shape the SDK sync store hydrates from —
// and is served from the durable mirror only.
//
// BOTH shapes carry `source` ('live' | 'mirror' | 'none') and `complete`. A
// non-running session no longer answers `unavailable` when a mirror exists: it
// answers with the mirror and SAYS that is what it did. The two are never
// merged.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/transcript',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/transcript',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      query: z.object({
        limit: z.string().optional(),
        chars: z.string().optional(),
        shape: z.enum(['compact', 'sync']).optional(),
      }),
    },
    responses: {
      200: json(AnyObject, 'Compact session transcript'),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const limit = parseBoundedPositiveInt(c.req.query('limit'), 40, 1, 500, 'limit');
    if (!limit.ok) return c.json({ error: limit.error }, 400);
    const maxChars = parseBoundedPositiveInt(c.req.query('chars'), 700, 80, 5000, 'chars');
    if (!maxChars.ok) return c.json({ error: maxChars.error }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );

    const visible = await loadVisibleSession(
      loaded,
      sessionId,
      c.get('sessionId') ?? null,
      callerKortixSessionId(c),
    );
    if (!visible) return c.json({ error: 'Not found' }, 404);

    if (c.req.query('shape') === 'sync') {
      return c.json(
        await buildSessionTranscriptSyncEnvelope({ session: visible.row, limit: limit.value }),
      );
    }

    const transcript = await buildSessionTranscriptDigest({
      session: visible.row,
      projectId,
      accountId: loaded.row.accountId,
      userId: loaded.userId,
      limit: limit.value,
      maxChars: maxChars.value,
    });
    return c.json(transcript);
  },
);
