import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The Teams sign-in link links the Teams user it names to whoever opens it
// (identity-routes.ts `/bind`). Until 2026-09-28 the card carrying it was
// posted in every conversation, so in a channel or group chat anyone who saw
// it within its 10 minutes could link that person's Teams identity to their own
// Kortix account, and that person's messages would then run as them. The link
// is shown only where that person alone sees it: a one-to-one chat, or a
// targeted message ("Only you can see this message"). Until 2026-10-01 a
// channel or group chat showed everyone a card that sent the person to a
// private chat.

mock.module('../lib/config', () => ({
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

// Every card the prompt sends, by where it went: `public` is the conversation
// itself, `direct` the person's 1:1 chat with the bot.
type Sent = { to: 'targeted' | 'public' | 'direct' | 'replaced'; card: unknown; recipient?: string; activityId?: string };
let sent: Sent[] = [];
let targetedAccepted = true;
let directOpens = true;
const directCalls: Array<{ projectId: string; tenantId: string; userId: string }> = [];
mock.module('../channels/teams-api', () => ({
  sendTargetedCard: async (_ref: unknown, recipient: string, card: unknown) => {
    if (!targetedAccepted) return null;
    sent.push({ to: 'targeted', card, recipient });
    return 'act-targeted';
  },
  openDirectConversation: async (input: { projectId: string; tenantId: string; userId: string }) => {
    directCalls.push(input);
    return directOpens ? { serviceUrl: 'https://smba.trafficmanager.net/emea/', conversationId: 'a:direct', projectId: input.projectId } : null;
  },
  sendCard: async (ref: { conversationId: string }, card: unknown) => {
    sent.push({ to: ref.conversationId === 'a:direct' ? 'direct' : 'public', card });
    return 'act-sent';
  },
  updateCard: async (_ref: unknown, activityId: string, card: unknown) => {
    sent.push({ to: 'replaced', card, activityId });
    return true;
  },
}));

const { sendTeamsLoginPrompt, botChatUrl } = await import('../channels/teams/login-card');
const { verifyTeamsLoginState } = await import('../channels/teams/login');

const ref = { serviceUrl: 'https://smba.trafficmanager.net/emea/', conversationId: 'conv-1', projectId: 'proj-1' };
const activity = (conversationType?: string) => ({
  type: 'message',
  conversation: { id: 'conv-1', ...(conversationType ? { conversationType } : {}) },
  recipient: { id: '28:bot-app-id', name: 'Kortix Dev' },
  from: { id: '29:user', aadObjectId: 'aad-user' },
});
const prompt = (conversationType: string | undefined, extra: Record<string, unknown> = {}) =>
  sendTeamsLoginPrompt({ ref, activity: activity(conversationType), tenantId: 't1', teamsUserId: 'aad-user', ...extra });
const json = (card: unknown) => JSON.stringify(card);
/** The signed token of the sign-in link on a card, or null when it carries none. */
const loginToken = (card: unknown) => /\/teams\/login\/([^"]+)/.exec(json(card))?.[1] ?? null;
const shared = (to: Sent['to']) => to === 'public' || to === 'replaced';

beforeEach(() => {
  latestPending = null;
  latestCalls.length = 0;
  sent = [];
  targetedAccepted = true;
  directOpens = true;
  directCalls.length = 0;
});

describe('sendTeamsLoginPrompt in a one-to-one chat', () => {
  test('posts the sign-in link, carrying the message it answers', async () => {
    await prompt('personal', { pendingId: 'p-1' });
    expect(sent.map((s) => s.to)).toEqual(['public']);
    expect(verifyTeamsLoginState(loginToken(sent[0]!.card)!)).toMatchObject({ tenantId: 't1', teamsUserId: 'aad-user', pendingId: 'p-1' });
    expect(json(sent[0]!.card)).toContain('within 10 minutes');
    expect(latestCalls).toHaveLength(0);
  });

  test('/login carries the newest message the user parked in a shared conversation', async () => {
    latestPending = 'p-channel';
    await prompt('personal');
    expect(verifyTeamsLoginState(loginToken(sent[0]!.card)!)?.pendingId).toBe('p-channel');
    expect(latestCalls).toEqual([{ tenantId: 't1', teamsUserId: 'aad-user' }]);
  });

  test("replaces the person's own live card instead of stacking under it", async () => {
    await prompt('personal', { pendingId: 'p-1', replaceActivityId: 'live-1' });
    expect(sent.map((s) => [s.to, s.activityId])).toEqual([['replaced', 'live-1']]);
    expect(loginToken(sent[0]!.card)).not.toBeNull();
  });

  test('never uses a targeted message or the separate 1:1 chat', async () => {
    await prompt('personal');
    expect(sent.some((s) => s.to === 'targeted')).toBe(false);
    expect(directCalls).toEqual([]);
  });
});

describe('sendTeamsLoginPrompt in a channel or group chat', () => {
  test('the link goes in a targeted message to the sender alone, and nothing is posted for everyone', async () => {
    for (const type of ['channel', 'groupChat', undefined]) {
      sent = [];
      await prompt(type, { pendingId: 'p-1', replaceActivityId: 'someone-elses-card' });
      expect(sent.map((s) => [s.to, s.recipient])).toEqual([['targeted', '29:user']]);
      expect(verifyTeamsLoginState(loginToken(sent[0]!.card)!)).toMatchObject({ tenantId: 't1', teamsUserId: 'aad-user', pendingId: 'p-1' });
      expect(json(sent[0]!.card)).toContain('Connect or create account');
      expect(json(sent[0]!.card)).toContain('within 10 minutes');
    }
    expect(directCalls).toEqual([]);
  });

  test('/login with no parked message promises nothing will run', async () => {
    await prompt('channel');
    expect(sent.map((s) => s.to)).toEqual(['targeted']);
    expect(json(sent[0]!.card)).not.toContain('within 10 minutes');
  });

  test('Teams refuses the targeted message: the link goes to the 1:1 chat, and the conversation card only says so', async () => {
    targetedAccepted = false;
    await prompt('channel', { pendingId: 'p-1' });
    expect(directCalls).toEqual([{ projectId: 'proj-1', tenantId: 't1', userId: 'aad-user' }]);
    expect(sent.map((s) => s.to)).toEqual(['direct', 'public']);
    expect(verifyTeamsLoginState(loginToken(sent[0]!.card)!)).toMatchObject({ teamsUserId: 'aad-user', pendingId: 'p-1' });
    expect(loginToken(sent[1]!.card)).toBeNull();
    expect(json(sent[1]!.card)).toContain('I sent you the sign-in link in your private chat with Kortix Dev');
  });

  test('Teams refuses the targeted message and the 1:1 chat: the conversation card says where to go, with no link', async () => {
    targetedAccepted = false;
    directOpens = false;
    await prompt('groupChat', { pendingId: 'p-1' });
    expect(sent.map((s) => s.to)).toEqual(['public']);
    const text = json(sent[0]!.card);
    expect(loginToken(sent[0]!.card)).toBeNull();
    expect(text).not.toContain('/identity/login/');
    expect(text).toContain('send /login');
    expect(text).toContain('https://teams.microsoft.com/l/chat/0/0?users=28%3Abot-app-id');
    expect(text).toContain('within 10 minutes');
  });

  test('no card the whole conversation sees ever carries the link', async () => {
    for (const [targeted, direct] of [[true, true], [false, true], [false, false]] as const) {
      sent = [];
      targetedAccepted = targeted;
      directOpens = direct;
      await prompt('channel', { pendingId: 'p-1', replaceActivityId: 'live-1' });
      for (const s of sent.filter((s) => shared(s.to))) expect(loginToken(s.card)).toBeNull();
    }
  });

  test('a message with no Teams sender id cannot be targeted: the fallback runs', async () => {
    await sendTeamsLoginPrompt({
      ref,
      activity: { ...activity('channel'), from: { aadObjectId: 'aad-user' } } as never,
      tenantId: 't1',
      teamsUserId: 'aad-user',
    });
    expect(sent.map((s) => s.to)).toEqual(['direct', 'public']);
  });

  test('no Teams user at all: nothing is sent', async () => {
    await sendTeamsLoginPrompt({ ref, activity: activity('channel'), tenantId: 't1', teamsUserId: '' });
    expect(sent).toEqual([]);
  });
});

describe('botChatUrl', () => {
  test('opens a one-to-one chat only for a bot id', () => {
    expect(botChatUrl('28:abc')).toBe('https://teams.microsoft.com/l/chat/0/0?users=28%3Aabc');
    expect(botChatUrl('29:a-person')).toBeNull();
    expect(botChatUrl(undefined)).toBeNull();
  });
});
