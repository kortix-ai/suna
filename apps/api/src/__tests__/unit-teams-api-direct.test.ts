import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// The proactive one-to-one chat: admin notices, the "connected" confirmation,
// and a sign-in link asked for in a channel all go through it. Teams refuses it
// for a user without the app installed personally, so every caller needs the
// null answer to be clean.

const SERVICE_URL = 'https://smba.trafficmanager.net/emea/tenant-1/';
let storedServiceUrl: string | null = SERVICE_URL;
let byoCreds: { appId: string; appPassword: string } | null = null;

mock.module('../lib/config', () => ({ config: { MICROSOFT_APP_ID: 'managed-app' } }));
mock.module('../channels/install-store', () => ({
  loadTeamsServiceUrlForProject: async () => storedServiceUrl,
  loadTeamsBotCredentials: async () => byoCreds,
}));
mock.module('../channels/teams-auth', () => ({ botConnectorToken: async () => 'bot-token' }));

const calls: Array<{ method: string; url: string; body: unknown }> = [];
let reply: () => Response = () => Response.json({ id: 'a:1-direct' });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined });
  return reply();
}) as typeof fetch;

const { conversationMemberId, deleteActivity, getTeamsTeam, listTeamsTeamChannels, openDirectConversation, sendTargetedCard } =
  await import('../channels/teams-api');

beforeEach(() => {
  calls.length = 0;
  storedServiceUrl = SERVICE_URL;
  byoCreds = null;
  reply = () => Response.json({ id: 'a:1-direct' });
});
afterAll(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

describe('openDirectConversation', () => {
  test('creates the 1:1 chat with the user by AAD object id, as the managed bot', async () => {
    const ref = await openDirectConversation({ projectId: 'p1', tenantId: 'tenant-1', userId: 'aad-user-1' });
    expect(ref).toEqual({ serviceUrl: SERVICE_URL, conversationId: 'a:1-direct', botId: '28:managed-app', tenantId: 'tenant-1', projectId: 'p1' });
    expect(calls).toEqual([{
      method: 'POST',
      url: 'https://smba.trafficmanager.net/emea/tenant-1/v3/conversations',
      body: { isGroup: false, bot: { id: '28:managed-app' }, members: [{ id: 'aad-user-1' }], tenantId: 'tenant-1', channelData: { tenant: { id: 'tenant-1' } } },
    }]);
  });

  test('a per-project bot opens it as itself', async () => {
    byoCreds = { appId: 'byo-app', appPassword: 'x' };
    expect((await openDirectConversation({ projectId: 'p1', tenantId: 'tenant-1', userId: 'u' }))?.botId).toBe('28:byo-app');
  });

  test('a user without the app installed personally is null, not an error', async () => {
    reply = () => Response.json({ error: { code: 'BadArgument', message: "Bot is not installed in user's personal scope" } }, { status: 403 });
    expect(await openDirectConversation({ projectId: 'p1', tenantId: 'tenant-1', userId: 'u' })).toBeNull();
  });

  test('no stored service URL, or one outside Bot Framework, never calls out', async () => {
    storedServiceUrl = null;
    expect(await openDirectConversation({ projectId: 'p1', tenantId: 'tenant-1', userId: 'u' })).toBeNull();
    storedServiceUrl = 'https://attacker.example.test/';
    expect(await openDirectConversation({ projectId: 'p1', tenantId: 'tenant-1', userId: 'u' })).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('deleteActivity', () => {
  test('deletes the bot message by id, with no body', async () => {
    reply = () => new Response(null, { status: 200 });
    const ok = await deleteActivity({ serviceUrl: SERVICE_URL, conversationId: '19:c@thread.v2', projectId: 'p1' }, '1700000000000');
    expect(ok).toBe(true);
    expect(calls).toEqual([{ method: 'DELETE', url: `${SERVICE_URL}v3/conversations/19%3Ac%40thread.v2/activities/1700000000000`, body: undefined }]);
  });
});

// A card in a channel or group chat that only one person sees: Slack's
// ephemeral. What is said to one person in a shared conversation (the sign-in
// link, a refusal, a command reply) goes through it.
describe('sendTargetedCard', () => {
  const THREAD = '19:c@thread.tacv2;messageid=17';

  test('posts the card with isTargetedActivity and the one recipient', async () => {
    reply = () => Response.json({ id: '1700000000001' });
    const id = await sendTargetedCard({ serviceUrl: SERVICE_URL, conversationId: THREAD, projectId: 'p1' }, '29:user-1', { type: 'AdaptiveCard' });
    expect(id).toBe('1700000000001');
    expect(calls).toEqual([{
      method: 'POST',
      url: `${SERVICE_URL}v3/conversations/19%3Ac%40thread.tacv2%3Bmessageid%3D17/activities?isTargetedActivity=true`,
      body: {
        type: 'message',
        attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard' } }],
        recipient: { id: '29:user-1' },
      },
    }]);
  });

  test('a refusal is null, so the caller falls back', async () => {
    reply = () => Response.json({ error: { code: 'BotNotInConversationRoster' } }, { status: 403 });
    expect(await sendTargetedCard({ serviceUrl: SERVICE_URL, conversationId: THREAD, projectId: 'p1' }, '29:user-1', {})).toBeNull();
  });
});

describe('conversationMemberId', () => {
  test('reads the Teams user id of a member by Entra object id, from the channel a thread is in', async () => {
    reply = () => Response.json({ id: '29:user-1', aadObjectId: 'aad-user-1', name: 'Test User' });
    const id = await conversationMemberId({ serviceUrl: SERVICE_URL, conversationId: '19:c@thread.tacv2;messageid=17', projectId: 'p1' }, 'aad-user-1');
    expect(id).toBe('29:user-1');
    expect(calls).toEqual([{ method: 'GET', url: `${SERVICE_URL}v3/conversations/19%3Ac%40thread.tacv2/members/aad-user-1`, body: undefined }]);
  });

  test('someone Teams does not know in that conversation is null', async () => {
    reply = () => Response.json({ error: { code: 'MemberNotFoundInConversation' } }, { status: 404 });
    expect(await conversationMemberId({ serviceUrl: SERVICE_URL, conversationId: '19:g@thread.v2', projectId: 'p1' }, 'aad-x')).toBeNull();
  });
});

// The names a channel binding shows: a Teams message carries the team's id but
// rarely its name. Shapes as the Bot Connector answered for a test tenant.
describe('team reads', () => {
  const TEAM = '19:team-root@thread.tacv2';

  test('reads a team by its id', async () => {
    reply = () => Response.json({ id: TEAM, name: 'Eng', aadGroupId: 'aad-group-1', channelCount: 2, memberCount: 3 });
    expect(await getTeamsTeam(SERVICE_URL, TEAM, 'p1')).toEqual({ id: TEAM, name: 'Eng' });
    expect(calls).toEqual([{ method: 'GET', url: `${SERVICE_URL}v3/teams/19%3Ateam-root%40thread.tacv2`, body: undefined }]);
  });

  test('an id that is not a team, or any failure, is null', async () => {
    reply = () => Response.json({ error: { code: 'BadArgument', message: 'Cannot find team with provided id' } }, { status: 404 });
    expect(await getTeamsTeam(SERVICE_URL, '19:design@thread.tacv2', 'p1')).toBeNull();
    reply = () => new Response('not json', { status: 200 });
    expect(await getTeamsTeam(SERVICE_URL, TEAM, 'p1')).toBeNull();
  });

  test('lists the channels of a team; General arrives without a name', async () => {
    reply = () =>
      Response.json({ conversations: [{ type: 'standard', id: TEAM }, { type: 'standard', id: '19:design@thread.tacv2', name: 'Design' }] });
    expect(await listTeamsTeamChannels(SERVICE_URL, TEAM, 'p1')).toEqual([
      { id: TEAM, name: null },
      { id: '19:design@thread.tacv2', name: 'Design' },
    ]);
    expect(calls).toEqual([{ method: 'GET', url: `${SERVICE_URL}v3/teams/19%3Ateam-root%40thread.tacv2/conversations`, body: undefined }]);
  });

  test('never sends the bot token to a host that is not the Bot Framework', async () => {
    expect(await getTeamsTeam('https://attacker.example/', TEAM, 'p1')).toBeNull();
    expect(await listTeamsTeamChannels('https://attacker.example/', TEAM, 'p1')).toBeNull();
    expect(calls).toEqual([]);
  });
});
