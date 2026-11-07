import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accounts, projects, chatPendingAuthMessages } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { createPendingSlackAuthMessage, createPendingSlackPickerMessage } from '../channels/slack/auth-resume';
import type { SlackEnvelope, SlackEvent } from '../channels/slack/types';

const accountId = crypto.randomUUID();
const projectId = crypto.randomUUID();
const teamId = `pending-${crypto.randomUUID()}`;
const event: SlackEvent = { type: 'app_mention', user: 'synthetic-user', channel: 'synthetic-channel', text: 'hello', ts: '1.0' };
const envelope: SlackEnvelope = { type: 'event_callback', team_id: teamId, event };
beforeAll(async () => {
  await db.insert(accounts).values({ accountId, name: 'pending-test' });
  await db.insert(projects).values({ projectId, accountId, name: 'pending-test', repoUrl: 'https://example.test/synthetic.git', metadata: {} });
});
afterAll(async () => {
  await db.delete(chatPendingAuthMessages).where(eq(chatPendingAuthMessages.platformTeamId, teamId));
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

test('auth and picker persist exact payloads, ownership and independent TTLs; next insertion cleans expired rows', async () => {
  const before = Date.now();
  const authId = await createPendingSlackAuthMessage({ projectId, teamId, slackUserId: 'auth-user', envelope, event });
  const pickerId = await createPendingSlackPickerMessage({ teamId, envelope, ttlMs: 120_000 });
  const rows = await db.select().from(chatPendingAuthMessages).where(eq(chatPendingAuthMessages.platformTeamId, teamId));
  expect(rows).toHaveLength(2);
  const auth = rows.find(row => row.pendingId === authId);
  const picker = rows.find(row => row.pendingId === pickerId);
  expect(auth).toMatchObject({ projectId, platform: 'slack', platformTeamId: teamId, platformUserId: 'auth-user', envelope, event });
  expect(picker).toMatchObject({ projectId: null, platform: 'slack', platformTeamId: teamId, platformUserId: 'synthetic-user', envelope, event });
  expect(auth?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 600_000);
  expect(picker?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 120_000);
  const expiredId = await createPendingSlackPickerMessage({ teamId, envelope, ttlMs: -1 });
  await createPendingSlackPickerMessage({ teamId, envelope: { ...envelope, event: { ...event, user: undefined } }, ttlMs: 60_000 });
  const remaining = await db.select().from(chatPendingAuthMessages).where(eq(chatPendingAuthMessages.platformTeamId, teamId));
  expect(remaining.some(row => row.pendingId === expiredId)).toBe(false);
  expect(remaining.some(row => row.platformUserId === '')).toBe(true);
});

test('invalid caller guards store no rows', async () => {
  expect(await createPendingSlackAuthMessage({ projectId, teamId: '', slackUserId: 'user', envelope, event })).toBeNull();
  expect(await createPendingSlackAuthMessage({ projectId, teamId, slackUserId: '', envelope, event })).toBeNull();
  expect(await createPendingSlackPickerMessage({ teamId, envelope: { type: 'event_callback' }, ttlMs: 1000 })).toBeNull();
  expect(await createPendingSlackPickerMessage({ teamId: '', envelope, ttlMs: 1000 })).toBeNull();
});
