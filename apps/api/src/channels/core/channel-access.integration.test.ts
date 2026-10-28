/**
 * Real-Postgres contract for the channel access store (channel-access.ts) with
 * a second platform beside Telegram: each platform's lists live under its own
 * metadata key, concurrent writes to both all land, an id is stored as sent,
 * the install check is per platform, and project reads hide every listed key.
 * The profile half (channel-access-profiles.ts) keeps each platform's profiles
 * apart and serves a photo only as a type its port declares. The gate records
 * a direct request under its own platform and names that platform in its replies.
 * The Telegram behaviour itself is pinned by telegram.integration.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chatInstalls, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { removeSeeded, seedProject, type SeededProject } from '../../__tests__/helpers/integration-fixtures';
import { serializeProject } from '../../projects/lib/serializers';
import { CHANNEL_ACCESS_PLATFORMS, type ChannelAccessPlatform } from '../../shared/channel-access-platforms';
import { db } from '../../shared/db';
import {
  allowChannelUser,
  type ChannelAccessPort,
  type ChannelAccessRequester,
  type ChannelPhotoType,
  clearChannelAccessRequests,
  dismissChannelAccessRequest,
  gateSender,
  readChannelAccess,
  recordChannelAccessRequest,
  refusedPressText,
  removeChannelUser,
  setChannelAllowedUsers,
} from './channel-access';
import { channelUserPhoto, listChannelUsers } from './channel-access-profiles';

/** A platform the list does not name yet: `chat_installs.platform` is a plain varchar. */
const FAKE_KEY: string = 'fakechat';
const FAKE = FAKE_KEY as ChannelAccessPlatform;
const SCOPE = `W${crypto.randomUUID().slice(0, 8)}`;
/** A Discord-style snowflake: above 2^53, so it must never pass through a number. */
const SNOWFLAKE = '1153923484926419082';
const TELEGRAM = {
  allowedUserIds: ['111'],
  accessRequests: [{ id: '222', username: 'synthetic', first_name: 'Synthetic', last_name: null, last_seen: new Date().toISOString() }],
};

let project: SeededProject;
const requester = (id: string) => ({ id, username: `user_${id}`, first_name: 'Synthetic', last_name: null });
const metadata = async () =>
  ((await db.select({ metadata: projects.metadata }).from(projects).where(eq(projects.projectId, project.project_id)))[0]!.metadata ??
    {}) as Record<string, any>;
const lists = async (platform: ChannelAccessPlatform) => readChannelAccess(await metadata(), platform);
const scope = { scopeId: SCOPE, accessRequests: [] };

/** A port over the stored lists whose every user is `name` with one photo of `bytes`. */
const port = (
  platform: ChannelAccessPlatform,
  name: string,
  photoTypes: ChannelPhotoType[] = [],
  bytes = new Uint8Array(),
): ChannelAccessPort => ({
  platform,
  label: name,
  userId: /^\d+$/,
  idDescription: 'numeric id',
  photoTypes,
  connection: async () => ({ scopeId: SCOPE, credential: 'synthetic', lists: readChannelAccess(await metadata(), platform) }),
  installation: async () => ({}),
  requester: (from) => from as ChannelAccessRequester,
  fetchProfile: async () => ({ username: null, first_name: name, last_name: null, photo: { ref: 'r', version: name } }),
  fetchPhoto: async () => bytes,
});

beforeAll(async () => {
  project = await seedProject(`access-${crypto.randomUUID().slice(0, 8)}`);
  await db.insert(chatInstalls).values([
    { platform: 'telegram', workspaceId: SCOPE, projectId: project.project_id },
    { platform: FAKE, workspaceId: SCOPE, projectId: project.project_id },
  ]);
});

beforeEach(async () => {
  await db.update(projects).set({ metadata: { telegram: TELEGRAM } }).where(eq(projects.projectId, project.project_id));
});

afterAll(async () => {
  await db.delete(chatInstalls).where(eq(chatInstalls.projectId, project.project_id));
  await removeSeeded([project]);
});

describe('channel access store — a second platform beside Telegram', () => {
  test('every write to another platform leaves metadata.telegram as it was', async () => {
    expect(await allowChannelUser(FAKE, project.project_id, '1')).toBe(true);
    expect(await recordChannelAccessRequest(FAKE, project.project_id, scope, requester('2'))).toBe(true);
    await setChannelAllowedUsers(FAKE, project.project_id, ['1', '3']);
    await removeChannelUser(FAKE, project.project_id, '3');
    await dismissChannelAccessRequest(FAKE, project.project_id, '2');
    await clearChannelAccessRequests(FAKE, project.project_id);
    expect(await metadata()).toEqual({ telegram: TELEGRAM, [FAKE_KEY]: { allowedUserIds: ['1'] } });
  });

  test('concurrent allows and requests on both platforms all land', async () => {
    await Promise.all(
      ['telegram' as const, FAKE].flatMap((platform) => [
        ...['31', '32', '33'].map((id) => allowChannelUser(platform, project.project_id, id)),
        ...['41', '42', '43'].map((id) => recordChannelAccessRequest(platform, project.project_id, scope, requester(id))),
      ]),
    );
    const telegram = await lists('telegram');
    expect(telegram.allowedUserIds.slice().sort()).toEqual(['111', '31', '32', '33']);
    expect(telegram.accessRequests.map((r) => r.id).sort()).toEqual(['222', '41', '42', '43']);
    const fake = await lists(FAKE);
    expect(fake.allowedUserIds.slice().sort()).toEqual(['31', '32', '33']);
    expect(fake.accessRequests.map((r) => r.id).sort()).toEqual(['41', '42', '43']);
  });

  test('an id above 2^53 is stored and read back exactly as sent', async () => {
    expect(await recordChannelAccessRequest(FAKE, project.project_id, scope, requester(SNOWFLAKE))).toBe(true);
    expect((await metadata())[FAKE].accessRequests[0].id).toBe(SNOWFLAKE);
    expect(await allowChannelUser(FAKE, project.project_id, SNOWFLAKE)).toBe(true);
    expect(await lists(FAKE)).toEqual({ allowedUserIds: [SNOWFLAKE], accessRequests: [] });
  });

  test("a request is stored only while the project has that platform's install with that scope", async () => {
    const other = `W${crypto.randomUUID().slice(0, 8)}`;
    // Telegram has an install with `other`; the fake platform does not.
    await db.insert(chatInstalls).values({ platform: 'telegram', workspaceId: other, projectId: project.project_id });
    try {
      expect(await recordChannelAccessRequest(FAKE, project.project_id, { scopeId: other, accessRequests: [] }, requester('51'))).toBe(false);
      expect((await metadata())[FAKE]).toBeUndefined();
      expect(await recordChannelAccessRequest('telegram', project.project_id, { scopeId: other, accessRequests: [] }, requester('51'))).toBe(true);
      expect((await lists('telegram')).accessRequests.map((r) => r.id)).toContain('51');
    } finally {
      await db.delete(chatInstalls).where(eq(chatInstalls.workspaceId, other));
    }
  });

  test('a project read hides every platform in CHANNEL_ACCESS_PLATFORMS and keeps the other keys', async () => {
    const stored = Object.fromEntries(CHANNEL_ACCESS_PLATFORMS.map((platform) => [platform, TELEGRAM]));
    await db.update(projects).set({ metadata: { ...stored, keep: 1 } }).where(eq(projects.projectId, project.project_id));
    const [row] = await db.select().from(projects).where(eq(projects.projectId, project.project_id));
    const shown = serializeProject(row!).metadata;
    for (const platform of CHANNEL_ACCESS_PLATFORMS) expect(shown).not.toHaveProperty(platform);
    expect(shown).toMatchObject({ keep: 1 });
  });

  test("a profile looked up for one platform never names the other platform's user with the same id and scope", async () => {
    await setChannelAllowedUsers('telegram', project.project_id, ['71']);
    await setChannelAllowedUsers(FAKE, project.project_id, ['71']);
    expect((await listChannelUsers(port('telegram', 'Tele'), project.project_id))!.allowed[0]).toMatchObject({ first_name: 'Tele' });
    expect((await listChannelUsers(port(FAKE, 'Fake'), project.project_id))!.allowed[0]).toMatchObject({ first_name: 'Fake' });
  });

  test('a photo is served only when its magic bytes match a type the port declares, and as that type', async () => {
    await setChannelAllowedUsers(FAKE, project.project_id, ['81']);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const webp = new TextEncoder().encode('RIFF\x10\x00\x00\x00WEBPVP8 ');
    const photo = (types: ChannelPhotoType[], bytes: Uint8Array<ArrayBuffer>) =>
      channelUserPhoto(port(FAKE, 'Photo', types, bytes), project.project_id, '81');
    const unavailable = { ok: false, code: 'photo_unavailable' } as const;
    expect(await photo(['image/jpeg'], png)).toEqual(unavailable);
    expect(await photo(['image/jpeg'], webp)).toEqual(unavailable);
    expect(await photo(['image/png', 'image/webp'], jpeg)).toEqual(unavailable);
    expect(await photo(['image/jpeg'], jpeg.slice(0, 2))).toEqual(unavailable);
    expect(await photo(['image/jpeg'], jpeg)).toEqual({ ok: true, bytes: jpeg, contentType: 'image/jpeg' });
    expect(await photo(['image/jpeg', 'image/png'], png)).toEqual({ ok: true, bytes: png, contentType: 'image/png' });
    expect(await photo(['image/webp'], webp)).toEqual({ ok: true, bytes: webp, contentType: 'image/webp' });
    // Only a listed user: the bot is no lookup service.
    expect(await channelUserPhoto(port(FAKE, 'Photo', ['image/jpeg'], jpeg), project.project_id, '82')).toEqual({
      ok: false,
      code: 'user_unknown',
    });
  });

  test('the gate passes an allowed sender, records only a direct request under its own platform, and names that platform', async () => {
    await setChannelAllowedUsers(FAKE, project.project_id, ['90']);
    const gate = (senderId: string, direct: boolean) =>
      lists(FAKE).then((stored) =>
        gateSender(port(FAKE, 'Fakechat'), { projectId: project.project_id, scopeId: SCOPE, lists: stored, senderId, direct, from: requester(senderId) }),
      );
    expect(await gate('90', true)).toBeNull();
    expect(await gate('91', false)).toBe(
      'This bot belongs to a Kortix project, and your Fakechat account is not allowed to use it yet. Ask a project admin to allow your Fakechat user ID 91 under Customize → Connectors → Channels → Fakechat, or message this bot privately to ask for access.',
    );
    expect((await lists(FAKE)).accessRequests).toEqual([]);
    expect(await gate('91', true)).toBe(
      'This bot belongs to a Kortix project, and your Fakechat account is not allowed to use it yet. Your request is waiting for a project admin, who can allow it in Kortix under Customize → Connectors → Channels → Fakechat. Your Fakechat user ID is 91.',
    );
    expect((await lists(FAKE)).accessRequests.map((r) => r.id)).toEqual(['91']);
    expect((await metadata()).telegram).toEqual(TELEGRAM);
    expect(refusedPressText(port(FAKE, 'Fakechat'), '91')).toBe(
      'Your Fakechat account is not allowed to use this bot. Ask a project admin to allow user ID 91 under Customize → Connectors → Channels → Fakechat.',
    );
  });
});
