import { createRoute, z } from '@hono/zod-openapi';
import { accountGroupMembers } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../lib/db';
import {
  assertProjectCapability,
  loadProjectForUser,
  loadVisibleSession,
  projectCapabilityAllowed,
  resolveUserIdentities,
  sessionIsTombstoned,
} from '../lib/access';
import { projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../../services/sessions/caller-session';
import { buildProjectAccessView } from '../lib/project-access-view';
import { SESSION_PARTICIPANT_LIMIT, buildSessionParticipants, sessionAudienceIds } from '../../services/sessions/session-audience';

const ParticipantSchema = z.object({
  user_id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  avatar_url: z.string().nullable(),
  is_viewer: z.boolean(),
});
export function registerSessionParticipantsRoutes(): void {
  // GET /v1/projects/:projectId/sessions/:sessionId/participants
  // Who can open the session. Who wrote each message is `.../message-authors`.

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/sessions/{sessionId}/participants',
      tags: ['sessions'],
      summary: 'List who can open a session',
      ...auth,
      request: { params: z.object({ projectId: z.string().uuid(), sessionId: z.string() }) },
      responses: {
        200: json(
          z.object({
            participants: z.array(ParticipantSchema),
            total: z.number(),
            multi_user: z.boolean(),
          }),
          'Session participants',
        ),
        ...errors(403, 404),
      },
    }),
    async (c) => {
      const { projectId, sessionId } = c.req.valid('param');
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const { accountId } = loaded.row;
      await assertProjectCapability(c, loaded.userId, accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
      const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
      if (!visible || sessionIsTombstoned(visible.row)) return c.json({ error: 'Not found' }, 404);

      const visibility = visible.row.visibility as 'private' | 'project' | 'restricted';
      const groupIds = visible.grants.filter((g) => g.principalType === 'group').map((g) => g.principalId);
      // A private session is its owner alone: no roster read.
      const [canReadMembers, access, groupRows] = await Promise.all([
        projectCapabilityAllowed(c, loaded.userId, accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_READ),
        visibility === 'private' ? null : buildProjectAccessView(loaded),
        visibility === 'restricted' && groupIds.length
          ? db
              .select({ groupId: accountGroupMembers.groupId, userId: accountGroupMembers.userId })
              .from(accountGroupMembers)
              .where(inArray(accountGroupMembers.groupId, groupIds))
          : [],
      ]);
      const groupMembers = new Map<string, string[]>();
      for (const row of groupRows) {
        groupMembers.set(row.groupId, [...(groupMembers.get(row.groupId) ?? []), row.userId]);
      }

      const ownerId = visible.row.createdBy ?? null;
      const audienceIds = sessionAudienceIds({
        ownerId,
        visibility,
        grants: visible.grants,
        rosterIds: (access?.members ?? []).filter((m) => m.effective_project_role).map((m) => m.user_id),
        groupMembers,
      });
      const identities = await resolveUserIdentities([
        ...(ownerId ? [ownerId] : []),
        loaded.userId,
        ...audienceIds.slice(0, SESSION_PARTICIPANT_LIMIT),
      ]);

      return c.json(
        buildSessionParticipants({ viewerId: loaded.userId, ownerId, audienceIds, identities, canReadMembers }),
        200,
      );
    },
  );
}
