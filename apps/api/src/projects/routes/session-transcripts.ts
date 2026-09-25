/**
 * Session transcript reads.
 */

import { requireFeatureFlag } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { createRoute, z } from '@hono/zod-openapi';
import { loadProjectForUser, loadVisibleSession, assertProjectCapability } from '../lib/access';
import { callerKortixSessionId } from '../lib/caller-session';
import { AnyObject, projectsApp } from '../lib/app';
import { parseBoundedPositiveInt } from '../lib/serializers';
import { isUuid } from '../../shared/validate';
import {
  buildSessionTranscriptDigest,
  buildSessionTranscriptSyncEnvelope,
} from '../lib/session-transcript';
import { UnknownTranscriptCursorError } from '../lib/session-transcript-mirror';

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
//
// `shape=sync` pages BACKWARDS with `before=<message id>`, taken from the
// previous window's `next_cursor`, and reports `total`. Without them a reader
// could only ever see the newest `limit` messages of a history the mirror
// retains in full — the startup view asks for 40, and 25 of 375 mirrored dev
// sessions already hold more than that.

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
        history: z.enum(['true', 'false']).optional(),
        before: z.string().optional(),
      }),
    },
    responses: {
      200: json(AnyObject, 'Compact session transcript'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

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

    const history = c.req.query('history') === 'true';
    if (history) {
      const gate = requireFeatureFlag(c, loaded.row.metadata, 'session_transcript_history');
      if (gate) return gate;
    }

    if (c.req.query('shape') === 'sync') {
      // `before` walks older windows of the SAME mirror. A cursor naming no
      // mirrored message is answered 400 rather than with the newest window:
      // a client paging older would otherwise be handed page one forever.
      const before = c.req.query('before');
      if (before !== undefined && (before.length === 0 || before.length > 128)) {
        return c.json({ error: 'Invalid cursor' }, 400);
      }
      try {
        return c.json(
          await buildSessionTranscriptSyncEnvelope({
            session: visible.row,
            limit: limit.value,
            requireCurrentRoot: history,
            before: before ?? null,
          }),
        );
      } catch (err) {
        if (err instanceof UnknownTranscriptCursorError) {
          return c.json({ error: 'Unknown cursor' }, 400);
        }
        throw err;
      }
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
