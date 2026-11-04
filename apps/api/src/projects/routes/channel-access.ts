/**
 * A chat platform's channel access routes (channels/core/channel-access.ts):
 * its users and their photos, allow, remove and dismiss. Each platform
 * registers its own literal paths, so each keeps its own audit labels.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
  allowChannelUser,
  CHANNEL_MAX_ALLOWED_USERS,
  type ChannelAccessPort,
  type ChannelPhotoType,
  dismissChannelAccessRequest,
  removeChannelUser,
} from '../../channels/core/channel-access';
import { channelUserPhoto, listChannelUsers } from '../../channels/core/channel-access-profiles';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import type { AppEnv } from '../../types';

const PHOTO_NAMES: Record<ChannelPhotoType, string> = { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WebP' };

const UserParams = z.object({ projectId: z.string(), user_id: z.string() });

/** Load the project and check `capability` (none: project read is enough). */
export async function channelContext(c: Context<AppEnv>, capability?: string) {
  const projectId = c.req.param('projectId') ?? '';
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return { response: c.json({ error: 'Not found' }, 404) };
  if (capability) await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, capability);
  return { response: null, projectId } as const;
}

export const channelNotConnected = (c: Context<AppEnv>, port: ChannelAccessPort) =>
  c.json({ error: `${port.label} is not connected`, code: `${port.platform}_not_connected` }, 404);

export function registerChannelAccessRoutes(port: ChannelAccessPort): void {
  const { platform, label } = port;
  const base = `/{projectId}/channels/${platform}`;
  const invalidUserId = (c: Context<AppEnv>) =>
    c.json({ error: `user_id must be a ${port.idDescription}`, code: `${platform}_user_ids_invalid` }, 400);

  /** One list edit by user id (remove, dismiss): idempotent, answers the installation. */
  async function editByUserId(c: Context<AppEnv>, edit: typeof removeChannelUser) {
    const ctx = await channelContext(c, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
    if (ctx.response) return ctx.response;
    const userId = c.req.param('user_id') ?? '';
    if (!port.userId.test(userId)) return invalidUserId(c);
    if (!(await port.installation(ctx.projectId))) return channelNotConnected(c, port);
    await edit(platform, ctx.projectId, userId);
    return c.json(await port.installation(ctx.projectId), 200);
  }

  const UserSchema = z.object({
    user_id: z.string(),
    username: z.string().nullable(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    photo_version: z.string().nullable().openapi({ description: 'Changes when the photo changes; null: no photo' }),
    known: z.boolean().openapi({ description: `False: ${label} gave no profile and nothing is stored` }),
  });
  const UsersSchema = z.object({
    allowed: z.array(UserSchema),
    requests: z.array(UserSchema.extend({ last_seen: z.string() })),
  });

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: `${base}/users`,
      tags: ['channels'],
      summary: `List the allowed ${label} users and the access requests`,
      description:
        `Allowed users in list order and requests newest first, with names and a photo version from ${label}. ` +
        'A request is a not-allowed user who messaged the bot privately in the last 30 days.',
      ...auth,
      request: { params: z.object({ projectId: z.string() }) },
      responses: { 200: json(UsersSchema, 'OK'), ...errors(403, 404) },
    }),
    async (c: Context<AppEnv>) => {
      // Names and photos are personal data: the connector readers only.
      const ctx = await channelContext(c, PROJECT_ACTIONS.PROJECT_CONNECTOR_READ);
      if (ctx.response) return ctx.response;
      const users = await listChannelUsers(port, ctx.projectId);
      return users ? c.json(users) : channelNotConnected(c, port);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: `${base}/users/{user_id}/photo`,
      tags: ['channels'],
      summary: `An allowed or requesting ${label} user's profile photo`,
      description:
        `${port.photoTypes.map((type) => PHOTO_NAMES[type]).join(' or ')} bytes. ` +
        '`v` is the `photo_version` from the user list; it only changes the URL when the photo changes.',
      ...auth,
      request: { params: UserParams, query: z.object({ v: z.string().max(128).optional() }) },
      responses: { 200: { description: `The photo (${port.photoTypes.join(', ')})` }, ...errors(403, 404, 502) },
    }),
    async (c: Context<AppEnv>) => {
      const ctx = await channelContext(c, PROJECT_ACTIONS.PROJECT_CONNECTOR_READ);
      if (ctx.response) return ctx.response;
      const userId = c.req.param('user_id') ?? '';
      const photo = port.userId.test(userId)
        ? await channelUserPhoto(port, ctx.projectId, userId)
        : ({ ok: false, code: 'user_unknown' } as const);
      if (!photo.ok) {
        const message = {
          not_connected: `${label} is not connected`,
          user_unknown: `This ${label} user is not allowed and has not asked for access`,
          photo_unavailable: `This ${label} user has no photo the bot can see`,
          unreachable: `Could not reach ${label}`,
        }[photo.code];
        return c.json({ error: message, code: `${platform}_${photo.code}` }, photo.code === 'unreachable' ? 502 : 404);
      }
      return new Response(photo.bytes, {
        status: 200,
        headers: {
          'Content-Type': photo.contentType,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=86400',
        },
      }) as never;
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: `${base}/allowed-users`,
      tags: ['channels'],
      summary: `Allow one ${label} user`,
      description: 'Adds the id unless it is listed, and drops its access request. Answers the installation.',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        // `{ user_id }`, validated in the handler so every refusal carries a `code`.
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: { 200: json(z.any(), 'OK'), ...errors(400, 403, 404, 409) },
    }),
    async (c: Context<AppEnv>) => {
      const ctx = await channelContext(c, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
      if (ctx.response) return ctx.response;
      const userId = ((await c.req.json().catch(() => null)) as { user_id?: unknown } | null)?.user_id;
      if (typeof userId !== 'string' || !port.userId.test(userId)) return invalidUserId(c);
      if (!(await port.installation(ctx.projectId))) return channelNotConnected(c, port);
      if (!(await allowChannelUser(platform, ctx.projectId, userId))) {
        return c.json(
          { error: `At most ${CHANNEL_MAX_ALLOWED_USERS} ${label} users can be allowed`, code: `${platform}_allowed_users_full` },
          409,
        );
      }
      return c.json(await port.installation(ctx.projectId));
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: `${base}/allowed-users/{user_id}`,
      tags: ['channels'],
      summary: `Remove one allowed ${label} user`,
      description: 'Idempotent. Answers the installation.',
      ...auth,
      request: { params: UserParams },
      responses: { 200: json(z.any(), 'OK'), ...errors(400, 403, 404) },
    }),
    (c: Context<AppEnv>) => editByUserId(c, removeChannelUser),
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: `${base}/access-requests/{user_id}`,
      tags: ['channels'],
      summary: `Dismiss one ${label} access request`,
      description: 'Idempotent. The user can ask again by messaging the bot. Answers the installation.',
      ...auth,
      request: { params: UserParams },
      responses: { 200: json(z.any(), 'OK'), ...errors(400, 403, 404) },
    }),
    (c: Context<AppEnv>) => editByUserId(c, dismissChannelAccessRequest),
  );
}
