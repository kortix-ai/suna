import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The Teams sign-in link links the Teams user it names to whoever opens it
// (identity-routes.ts `/bind`). Until 2026-09-28 the card carrying it was
// posted in every conversation, so in a channel or group chat anyone who saw
// it within its 10 minutes could link that person's Teams identity to their own
// Kortix account, and that person's messages would then run as them. The link
// is now shown only in a one-to-one chat with the bot.

mock.module('../config', () => ({
  config: {
    MICROSOFT_APP_PASSWORD: 'teams-secret',
    API_KEY_SECRET: 'unit-test-api-key-secret',
    KORTIX_URL: '',
    FRONTEND_URL: 'https://app.kortix.com',
    TEAMS_APP_NAME: 'Kortix',
  },
}));

let latestPending: string | null = null;
const latestCalls: Array<{ tenantId: string; teamsUserId: string }> = [];
mock.module('../channels/teams/auth-resume', () => ({
  latestPendingTeamsAuthMessageId: async (input: { tenantId: string; teamsUserId: string }) => {
    latestCalls.push(input);
    return latestPending;
  },
}));

const { teamsLoginCard, botChatUrl } = await import('../channels/teams/login-card');
const { verifyTeamsLoginState } = await import('../channels/teams/login');

const activity = (conversationType?: string) => ({
  type: 'message',
  conversation: { id: 'conv-1', ...(conversationType ? { conversationType } : {}) },
  recipient: { id: '28:bot-app-id', name: 'Kortix Dev' },
  from: { id: '29:user', aadObjectId: 'aad-user' },
});
const json = (card: unknown) => JSON.stringify(card);
/** The signed token of the sign-in link on a card, or null when it carries none. */
const loginToken = (card: unknown) => /\/teams\/login\/([^"]+)/.exec(json(card))?.[1] ?? null;

beforeEach(() => {
  latestPending = null;
  latestCalls.length = 0;
});

describe('teamsLoginCard', () => {
  test('a one-to-one chat gets the sign-in link, carrying the message it answers', async () => {
    const card = await teamsLoginCard({ activity: activity('personal'), tenantId: 't1', teamsUserId: 'aad-user', pendingId: 'p-1' });
    const token = loginToken(card);
    expect(token).not.toBeNull();
    expect(verifyTeamsLoginState(token!)).toMatchObject({ tenantId: 't1', teamsUserId: 'aad-user', pendingId: 'p-1' });
    expect(latestCalls).toHaveLength(0);
  });

  test('/login in a one-to-one chat carries the newest message the user parked in a shared conversation', async () => {
    latestPending = 'p-channel';
    const card = await teamsLoginCard({ activity: activity('personal'), tenantId: 't1', teamsUserId: 'aad-user' });
    expect(verifyTeamsLoginState(loginToken(card)!)?.pendingId).toBe('p-channel');
    expect(latestCalls).toEqual([{ tenantId: 't1', teamsUserId: 'aad-user' }]);
  });

  test('a channel, a group chat, or a conversation of unknown type never shows the link', async () => {
    for (const type of ['channel', 'groupChat', undefined]) {
      const card = await teamsLoginCard({ activity: activity(type), tenantId: 't1', teamsUserId: 'aad-user', pendingId: 'p-1' });
      const text = json(card);
      expect(loginToken(card)).toBeNull();
      expect(text).not.toContain('/identity/login/');
      expect(text).toContain('send /login');
      expect(text).toContain('Open chat with Kortix Dev');
      expect(text).toContain('https://teams.microsoft.com/l/chat/0/0?users=28%3Abot-app-id');
      expect(text).toContain('within 10 minutes');
    }
    expect(latestCalls).toHaveLength(0);
  });

  test('with no parked message, the shared-conversation card promises nothing will run', async () => {
    const card = await teamsLoginCard({ activity: activity('channel'), tenantId: 't1', teamsUserId: 'aad-user' });
    expect(json(card)).not.toContain('within 10 minutes');
  });
});

describe('botChatUrl', () => {
  test('opens a one-to-one chat only for a bot id', () => {
    expect(botChatUrl('28:abc')).toBe('https://teams.microsoft.com/l/chat/0/0?users=28%3Aabc');
    expect(botChatUrl('29:a-person')).toBeNull();
    expect(botChatUrl(undefined)).toBeNull();
  });
});
