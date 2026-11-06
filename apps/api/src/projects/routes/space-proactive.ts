// GET/PUT /v1/projects/:projectId/spaces/:spaceId/proactive — a space's
// watcher settings (flag `spaces_proactive`, with `chat`): Proactive on or
// off, and the daily brief. lib/space-watch/ does the watching.
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { auth, errors, json } from '../../openapi';
import { canSeeSpace, spaceAccessFor } from '../../shared/space-access';
import { isUuid } from '../../shared/validate';
import type { AppEnv } from '../../types';
import { loadProjectForUser, projectCapabilityAllowed } from '../lib/access';
import { projectsApp } from '../lib/app';
import { findLiveSpace } from '../lib/project-spaces';
import { isTimeZone } from '../lib/space-watch/policy';
import { readWatcher, writeWatcher, type WatcherRow } from '../lib/space-watch/store';
import { workspaceIdParam } from '../../shared/route-params';

const SPACE_NOT_FOUND = { error: 'Space not found', code: 'space_not_found' } as const;

const ProactiveSchema = z.object({
  space_id: z.string(),
  /** The watcher reads the space's events and posts only when it matters. */
  enabled: z.boolean(),
  /** A short brief at 09:00 in `brief_timezone`, on a day with events. */
  daily_brief: z.boolean(),
  brief_timezone: z.string(),
  /** The caller may change these: the channel's creator, a project manager, or the DM's owner. */
  can_edit: z.boolean(),
});
const ProactiveInputSchema = z.object({
  enabled: z.boolean().optional(),
  daily_brief: z.boolean().optional(),
  /** An IANA zone, such as `Europe/Berlin`. The web app sends the browser's. */
  brief_timezone: z.string().trim().min(1).max(64).optional(),
});
const params = z.object({ workspaceId: z.string(), spaceId: z.string() });

function serialize(spaceId: string, row: WatcherRow | null, canEdit: boolean) {
  return {
    space_id: spaceId,
    enabled: row?.enabled ?? false,
    daily_brief: row?.dailyBrief ?? false,
    brief_timezone: row?.briefTimezone ?? 'UTC',
    can_edit: canEdit,
  };
}

/** The project, both flags, the space the caller may see, and whether they may edit it. */
async function loadSpace(c: Context<AppEnv>) {
  const loaded = await loadProjectForUser(c, workspaceIdParam(c)!, 'session');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'chat') ?? requireFeatureFlag(c, loaded.row.metadata, 'spaces_proactive');
  if (gate) return gate;
  const spaceId = c.req.param('spaceId')!;
  const space = isUuid(spaceId) ? await findLiveSpace(loaded.row.projectId, spaceId) : null;
  const bound = callerKortixSessionId(c);
  if (!space || (space.kind === 'dm' && space.dmUserId !== loaded.userId)) return c.json(SPACE_NOT_FOUND, 404);
  if (!canSeeSpace(space, await spaceAccessFor(loaded.row.projectId, loaded.userId, bound))) return c.json(SPACE_NOT_FOUND, 404);
  // A person decides it, never a session token: turning a watcher on spends model calls.
  const canEdit =
    bound === null &&
    (space.kind === 'dm'
      ? space.dmUserId === loaded.userId
      : space.createdBy === loaded.userId ||
        (await projectCapabilityAllowed(c, loaded.userId, loaded.row.accountId, loaded.row.projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)));
  return { loaded, space, canEdit, bound };
}

export function registerSpaceProactiveRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/spaces/{spaceId}/proactive',
      tags: ['spaces'],
      summary: 'Read a space’s Proactive settings',
      description:
        'Whether the space’s watcher is on and whether it sends a daily brief. Off until someone turns it on. ' +
        'Anyone who sees the space may read it. Flags `chat` and `spaces_proactive`.',
      ...auth,
      request: { params },
      responses: { 200: json(ProactiveSchema, 'The settings'), ...errors(403, 404) },
    }),
    async (c) => {
      const found = await loadSpace(c);
      if (found instanceof Response) return found;
      return c.json(serialize(found.space.spaceId, await readWatcher(found.space.spaceId), found.canEdit), 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'put',
      path: '/{workspaceId}/spaces/{spaceId}/proactive',
      tags: ['spaces'],
      summary: 'Change a space’s Proactive settings',
      description:
        'Turn the space’s watcher on or off, and its daily brief at 09:00 in `brief_timezone`. The watcher reads what happens in the space ' +
        '(finished threads, asks open over 2 h, people and agents who join) and posts, starts a thread or asks only when it matters, ' +
        'for the space’s creator (a DM: its owner), with that person’s rights. At most 24 wakes a day. ' +
        'Only the channel’s creator, a project manager or the DM’s owner may change it, and never with a session token: 403 `forbidden`. ' +
        'An unknown zone is 400 `invalid_timezone`. Flags `chat` and `spaces_proactive`.',
      ...auth,
      request: { params, body: { required: true, content: { 'application/json': { schema: ProactiveInputSchema } } } },
      responses: { 200: json(ProactiveSchema, 'The settings as stored'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const found = await loadSpace(c);
      if (found instanceof Response) return found;
      const { loaded, space, canEdit } = found;
      if (!canEdit) {
        return c.json({ error: 'Only the space’s creator, a workspace manager or the DM’s owner can change Proactive.', code: 'forbidden' }, 403);
      }
      const input = c.req.valid('json');
      if (input.brief_timezone !== undefined && !isTimeZone(input.brief_timezone)) {
        return c.json({ error: `Unknown time zone: ${input.brief_timezone}`, code: 'invalid_timezone' }, 400);
      }
      const row = await writeWatcher({
        projectId: loaded.row.projectId,
        spaceId: space.spaceId,
        // The watcher works for the space's creator; a space without one (#general) for the person who turned it on.
        ownerUserId: space.kind === 'dm' ? space.dmUserId! : (space.createdBy ?? loaded.userId),
        actorId: loaded.userId,
        enabled: input.enabled,
        dailyBrief: input.daily_brief,
        briefTimezone: input.brief_timezone,
      });
      return c.json(serialize(space.spaceId, row, true), 200);
    },
  );
}
