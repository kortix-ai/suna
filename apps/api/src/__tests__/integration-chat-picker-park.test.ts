/**
 * Integration test (real local PostgreSQL): a project-picker click replays the
 * message that triggered the picker, whichever replica receives the click. The
 * message is parked in `chat_pending_auth_messages` with no project yet. Real
 * rows, nothing faked.
 */
import { afterAll, expect, test } from 'bun:test';
import { chatPendingAuthMessages } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import {
  consumePendingSlackAuthMessage,
  consumePendingSlackPickerMessage,
  createPendingSlackPickerMessage,
} from '../services/channels/slack/auth-resume';
import type { SlackEnvelope } from '../services/channels/slack/types';
import {
  consumePendingTeamsPickerMessage,
  createPendingTeamsPickerMessage,
  latestPendingTeamsAuthMessageId,
} from '../services/channels/teams/auth-resume';
import type { TeamsActivity } from '../services/channels/teams/types';
import { db } from '../lib/db';

const WORKSPACE = `picker-park-${crypto.randomUUID()}`;

afterAll(async () => {
  await db.delete(chatPendingAuthMessages).where(inArray(chatPendingAuthMessages.workspaceId, [WORKSPACE]));
});

const slackEnvelope = (channel: string): SlackEnvelope => ({
  type: 'event_callback',
  team_id: WORKSPACE,
  event: { type: 'app_mention', user: 'U-picker', channel, text: 'run the report', ts: '1.0' },
});

test('Slack: the click replays the parked message once, only in its own channel', async () => {
  const pendingId = await createPendingSlackPickerMessage({
    teamId: WORKSPACE,
    envelope: slackEnvelope('C-one'),
    ttlMs: 60_000,
  });
  expect(pendingId).toMatch(/^[0-9a-f-]{36}$/);

  // The /login resume path never sees a picker row.
  expect(
    await consumePendingSlackAuthMessage({ pendingId: pendingId!, teamId: WORKSPACE, slackUserId: 'U-picker' }),
  ).toBeNull();
  // A click from another channel replays nothing and leaves the row.
  expect(await consumePendingSlackPickerMessage({ pendingId: pendingId!, teamId: WORKSPACE, channelId: 'C-two' })).toBeNull();

  const replayed = await consumePendingSlackPickerMessage({ pendingId: pendingId!, teamId: WORKSPACE, channelId: 'C-one' });
  expect(replayed?.event?.text).toBe('run the report');
  // Two replicas racing on the same click: only one replays.
  expect(await consumePendingSlackPickerMessage({ pendingId: pendingId!, teamId: WORKSPACE, channelId: 'C-one' })).toBeNull();
});

test('Slack: an expired or malformed picker id replays nothing', async () => {
  const pendingId = await createPendingSlackPickerMessage({ teamId: WORKSPACE, envelope: slackEnvelope('C-one'), ttlMs: -1 });
  expect(await consumePendingSlackPickerMessage({ pendingId: pendingId!, teamId: WORKSPACE, channelId: 'C-one' })).toBeNull();
  expect(await consumePendingSlackPickerMessage({ pendingId: 'not-a-uuid', teamId: WORKSPACE, channelId: 'C-one' })).toBeNull();
});

test('Teams: the picker message is stored (it was dropped before) and replayed once in its conversation', async () => {
  const activity = {
    type: 'message',
    text: 'summarize the thread',
    from: { id: 'aad-picker', name: 'Picker' },
    conversation: { id: 'conv-one' },
  } as unknown as TeamsActivity;
  const pendingId = await createPendingTeamsPickerMessage({ tenantId: WORKSPACE, teamsUserId: 'aad-picker', activity });
  expect(pendingId).toMatch(/^[0-9a-f-]{36}$/);

  // The /login resume lookup for the same person ignores the picker row.
  expect(await latestPendingTeamsAuthMessageId({ tenantId: WORKSPACE, teamsUserId: 'aad-picker' })).toBeNull();
  expect(
    await consumePendingTeamsPickerMessage({ pendingId: pendingId!, tenantId: WORKSPACE, conversationId: 'conv-two' }),
  ).toBeNull();

  const replayed = await consumePendingTeamsPickerMessage({
    pendingId: pendingId!,
    tenantId: WORKSPACE,
    conversationId: 'conv-one',
  });
  expect(replayed?.text).toBe('summarize the thread');
  expect(
    await consumePendingTeamsPickerMessage({ pendingId: pendingId!, tenantId: WORKSPACE, conversationId: 'conv-one' }),
  ).toBeNull();
});
