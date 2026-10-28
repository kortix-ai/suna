/**
 * Real-Postgres contract for the channel access store (channel-access.ts) with
 * a second platform beside Telegram: each platform's lists live under its own
 * metadata key, concurrent writes to both all land, an id is stored as sent,
 * the install check is per platform, and project reads hide every listed key.
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
  clearChannelAccessRequests,
  dismissChannelAccessRequest,
  readChannelAccess,
  recordChannelAccessRequest,
  removeChannelUser,
  setChannelAllowedUsers,
} from './channel-access';

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
});
