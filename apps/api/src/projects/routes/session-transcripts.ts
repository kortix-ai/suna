/**
 * Session transcript reads.
 */

import { PROJECT_ACTIONS } from '../../iam';
import { resolveSessionBinding } from './lib/route-bindings';
import { auth, errors, json } from '../../openapi';
import { createRoute, z } from '@hono/zod-openapi';
import { loadVisibleSession, assertProjectCapability } from '../lib/access';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { AnyObject, projectsApp, SessionTranscriptReadSchema } from '../lib/app';
import { parseBoundedPositiveInt } from '../lib/serializers';
import { isUuid } from '../../shared/validate';
import {
  buildSessionTranscriptDigest,
  buildSessionTranscriptSyncEnvelope,
} from '../lib/session-transcript';
import { UnknownTranscriptCursorError } from '../lib/session-transcript-mirror';
import { sessionMessageAuthors } from '../lib/session-message-authors';

export function registerSessionTranscriptsRoutes(): void {
  // GET /v1/projects/:projectId/sessions/:sessionId/transcript
  // Server-side transcript read for project automation. Unlike the raw /v1/p
  // sandbox proxy, this endpoint is callable with project-scoped session tokens.
  //
  // Two shapes, one route. `shape=compact` (the default, unchanged for every
  // existing caller) returns the digest rows, without tool inputs/outputs.
  // `shape=sync` returns OpenCode message envelopes with every part 1:1 except
  // attachment bytes — the shape the SDK sync store hydrates from — and is
  // served from the durable mirror only, in windows bounded by count and size.
  //
  // BOTH shapes carry `source` ('live' | 'mirror' | 'none') and `complete`. A
  // non-running session no longer answers `unavailable` when a mirror exists: it
  // answers with the mirror and SAYS that is what it did. The two are never
  // merged.
  //
  // `shape=sync` pages BACKWARDS with `before=<message id>`, taken from the
  // previous window's `next_cursor`, and reports `total`. `child=<ses_…>` reads
  // a sub-agent's own saved transcript instead of the root conversation. Without them a reader
  // could only ever see the newest `limit` messages of a history the mirror
  // retains in full — the startup view asks for 40, and 25 of 375 mirrored dev
  // sessions already hold more than that.

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/sessions/{sessionId}/transcript',
      tags: ['sessions'],
      summary: 'Read the transcript of a session',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string() }),
        query: z.object({
          limit: z.string().optional(),
          chars: z.string().optional(),
          shape: z.enum(['compact', 'sync']).optional(),
          history: z.enum(['true', 'false']).optional(),
          before: z.string().optional(),
          child: z.string().optional(),
          detail: z.enum(['compact', 'full']).optional(),
        }),
      },
      responses: {
        200: json(SessionTranscriptReadSchema, 'The transcript: compact digest, or the sync window with `shape=sync`'),
        ...errors(400, 403, 404),
      },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const sessionId = c.req.param('sessionId');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

      const limit = parseBoundedPositiveInt(c.req.query('limit'), 40, 1, 500, 'limit');
      if (!limit.ok) return c.json({ error: limit.error }, 400);
      const maxChars = parseBoundedPositiveInt(c.req.query('chars'), 700, 80, 5000, 'chars');
      if (!maxChars.ok) return c.json({ error: maxChars.error }, 400);

      const binding = await resolveSessionBinding(c, projectId, sessionId, 'read');
      if (binding.kind === 'error') return binding.response as never;
      const { loaded } = binding;
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

      // The saved-history read: it serves the mirror only for the session's
      // current OpenCode root.
      const history = c.req.query('history') === 'true';

      if (c.req.query('shape') === 'sync') {
        // `before` walks older windows of the SAME mirror. A cursor naming no
        // mirrored message is answered 400 rather than with the newest window:
        // a client paging older would otherwise be handed page one forever.
        const before = c.req.query('before');
        if (before !== undefined && (before.length === 0 || before.length > 128)) {
          return c.json({ error: 'Invalid cursor' }, 400);
        }
        // A sub-agent's own saved transcript, by its OpenCode session id. Only
        // rows stored under THIS session can answer, so an id from anywhere
        // else reads as nothing saved.
        const child = c.req.query('child');
        if (child !== undefined && !/^ses_[A-Za-z0-9]{1,124}$/.test(child)) {
          return c.json({ error: 'Invalid child session' }, 400);
        }
        try {
          return c.json(
            await buildSessionTranscriptSyncEnvelope({
              session: visible.row,
              limit: limit.value,
              requireCurrentRoot: history,
              before: before ?? null,
              child: child ?? null,
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
        full: c.req.query('detail') === 'full',
      });
      return c.json(transcript);
    },
  );

  // GET /v1/projects/:projectId/sessions/:sessionId/message-authors
  // Who wrote each message, from the authenticated prompt ledger: a member, or
  // another session's agent. The live runtime carries no author.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/sessions/{sessionId}/message-authors',
      tags: ['sessions'],
      summary: 'Read who wrote each message of a session',
      description:
        'Returns `authors`, keyed by runtime message id: `{kind:"member", user_id, name, email}` or `{kind:"session", session_id, name, agent?}` (`agent` is the agent the sending session runs). `initial_author` is the parent session for a spawned session\'s first message, else null.',
      ...auth,
      request: { params: z.object({ projectId: z.string(), sessionId: z.string() }) },
      responses: { 200: json(AnyObject, 'Message authors'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const sessionId = c.req.param('sessionId');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
      const binding = await resolveSessionBinding(c, projectId, sessionId, 'read');
      if (binding.kind === 'error') return binding.response as never;
      const { loaded } = binding;
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
      const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
      if (!visible) return c.json({ error: 'Not found' }, 404);
      return c.json(await sessionMessageAuthors(visible.row));
    },
  );
}
