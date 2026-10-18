import { createRoute, z } from '@hono/zod-openapi';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { groupMemberRows } from '../../iam/group-read';
import {
  assertProjectCapability,
  loadProjectForUser,
  loadVisibleSession,
  projectCapabilityAllowed,
  resolveUserIdentities,
  sessionIsTombstoned,
} from '../lib/access';
import { projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { loadProjectRosterIds } from '../lib/project-access-view';
import { buildSessionParticipants, sessionAudienceIds } from '../lib/session-audience';

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
      // A private session is its owner alone: no roster read. The roster is the
      // LEAN id read, not the access screen — `buildProjectAccessView` here
      // cost nine round trips to compute a list the route then reduced to
      // `user_id`s, and on a 6-connection per-task pool its tail was pool-wait,
      // not query time (KRTX-2727, measured 2026-10-20).
      const [canReadMembers, roster, groupRows] = await Promise.all([
        projectCapabilityAllowed(c, loaded.userId, accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_READ),
        visibility === 'private' ? Promise.resolve(null) : loadProjectRosterIds(loaded),
        visibility === 'restricted' && groupIds.length
          ? groupMemberRows(groupIds)
          : [],
      ]);
      const groupMembers = new Map<string, string[]>();
      for (const row of groupRows) {
        groupMembers.set(row.groupId, [...(groupMembers.get(row.groupId) ?? []), row.userId]);
      }

      const ownerId = visible.row.createdBy ?? null;
      // ONE identity read covers the roster (a shadow — a directory row that is
      // not a real auth user — drops out in buildSessionParticipants, as the
      // access screen's member fold drops it), the owner and the viewer.
      const identities = await resolveUserIdentities([
        ...(roster?.ids ?? []),
        ...(ownerId ? [ownerId] : []),
        loaded.userId,
      ]);
      // The access screen's member order: account-role rank, then email. It
      // decides WHO lands among the listed twenty on a big roster, so mirror it
      // here instead of the directory order the access view used to leak.
      const rank: Record<string, number> = { owner: 0, admin: 1, member: 2 };
      const rosterIds = (roster?.ids ?? []).sort((a, b) => {
          const roleDelta =
            (rank[roster?.accountRoles.get(a) ?? 'member'] ?? rank.member) -
            (rank[roster?.accountRoles.get(b) ?? 'member'] ?? rank.member);
          if (roleDelta !== 0) return roleDelta;
          return (identities.get(a)?.email ?? a).localeCompare(identities.get(b)?.email ?? b);
      });
      const audienceIds = sessionAudienceIds({
        ownerId,
        visibility,
        grants: visible.grants,
        rosterIds,
        groupMembers,
      });

      return c.json(
        buildSessionParticipants({ viewerId: loaded.userId, ownerId, audienceIds, identities, canReadMembers }),
        200,
      );
    },
  );
}
