/**
 * PUT /v1/projects/:projectId/sessions/:sessionId/stage — move a session's
 * card on the Monitoring board (docs/monitoring.md). The only writer of
 * `metadata.stage`; PATCH /sessions/:id rejects that key as server-managed.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { loadProjectForUser, loadVisibleSession } from '../lib/access';
import { AnyObject, SessionSchema, projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../lib/caller-session';
import { UUID_V4_REGEX, hasOwn, readBody, serializeSession } from '../lib/serializers';
import { SESSION_STAGE_NOTE_MAX, type SessionStageState, isSessionStage } from '../lib/session-stage';

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/sessions/{sessionId}/stage',
    tags: ['sessions'],
    summary: 'PUT /:projectId/sessions/:sessionId/stage',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      200: json(SessionSchema, 'The session with its new stage'),
      ...errors(400, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const body = await readBody(c);
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    // After membership authz (non-members learn nothing), before the session
    // lookup so a disabled project answers 403 even for an unknown session id.
    const gate = requireFeatureFlag(c, loaded.row.metadata, 'monitoring');
    if (gate) return gate;

    if (!isSessionStage(body.stage)) return c.json({ error: 'Invalid stage' }, 400);
    if (hasOwn(body, 'needs_approval') && typeof body.needs_approval !== 'boolean') {
      return c.json({ error: 'needs_approval must be a boolean' }, 400);
    }
    const note = body.note ?? null;
    if (note !== null && typeof note !== 'string') {
      return c.json({ error: 'note must be a string' }, 400);
    }
    if (typeof note === 'string' && note.length > SESSION_STAGE_NOTE_MAX) {
      return c.json({ error: `note must be at most ${SESSION_STAGE_NOTE_MAX} characters` }, 400);
    }

    const agentSessionId = callerKortixSessionId(c);
    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, agentSessionId);
    if (!visible) return c.json({ error: 'Not found' }, 404);

    if (agentSessionId && agentSessionId !== sessionId) {
      return c.json({ error: 'An agent can only move its own session' }, 403);
    }

    const stage: SessionStageState = {
      value: body.stage,
      needs_approval: body.needs_approval === true,
      note: note === '' ? null : note,
      updated_at: new Date().toISOString(),
      updated_by: agentSessionId ? 'agent' : loaded.userId,
    };

    const [row] = await db
      .update(projectSessions)
      .set({ metadata: { ...(visible.row.metadata ?? {}), stage }, updatedAt: new Date() })
      .where(
        and(
          eq(projectSessions.sessionId, sessionId),
          eq(projectSessions.projectId, projectId),
          eq(projectSessions.accountId, loaded.row.accountId),
        ),
      )
      .returning();
    if (!row) return c.json({ error: 'Not found' }, 404);

    return c.json(
      serializeSession(row, {
        grants: visible.grants,
        viewerId: loaded.userId,
        canManageProject: visible.canManageProject,
        ownerIsMachine: visible.ownerIsMachine,
      }),
    );
  },
);
